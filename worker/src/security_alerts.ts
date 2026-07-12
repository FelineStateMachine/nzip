import type { Env } from "./env.ts";
import {
  drainSecurityNotifications,
  enqueueNotification,
  notificationId,
} from "./security/notifications.ts";
import {
  chooseAlertAction,
  type IncidentRow,
  longestAdjacentRun,
  signalSeverity,
  type WindowStats,
} from "./security/policy.ts";

export {
  drainSecurityNotifications,
  sendAlertTest,
} from "./security/notifications.ts";
export { chooseAlertAction, signalSeverity } from "./security/policy.ts";
export type { AlertAction, WindowStats } from "./security/policy.ts";

async function loadWindow(env: Env, bucket: number): Promise<WindowStats> {
  const probes = await env.DB.prepare(
    `SELECT scanner_id, address, is_live, vault_slot, country, asn
     FROM security_probes WHERE bucket = ?`,
  ).bind(bucket).all<{
    scanner_id: string;
    address: number;
    is_live: number;
    vault_slot: number;
    country: string | null;
    asn: number | null;
  }>();
  const signals = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM security_signals
     WHERE bucket = ? AND kind = 'rate_limited'`,
  ).bind(bucket).first<{ count: number }>();

  const byScanner = new Map<string, number[]>();
  let liveHits = 0;
  let vaultMask = 0;
  const countries = new Set<string>();
  const asns = new Set<number>();
  for (const probe of probes.results) {
    const addresses = byScanner.get(probe.scanner_id) ?? [];
    addresses.push(probe.address);
    byScanner.set(probe.scanner_id, addresses);
    liveHits += probe.is_live;
    vaultMask |= 1 << probe.vault_slot;
    if (probe.country) countries.add(probe.country);
    if (probe.asn !== null) asns.add(probe.asn);
  }
  const scannerAddresses = [...byScanner.values()];
  return {
    bucket,
    addresses: probes.results.length,
    scanners: byScanner.size,
    misses: probes.results.length - liveHits,
    liveHits,
    rateLimited: signals?.count ?? 0,
    topScannerAddresses: Math.max(
      0,
      ...scannerAddresses.map((values) => values.length),
    ),
    longestSequence: Math.max(0, ...scannerAddresses.map(longestAdjacentRun)),
    vaultMask,
    countries: [...countries].sort().slice(0, 10),
    asns: [...asns].sort((a, b) => a - b).slice(0, 10),
  };
}

export async function evaluateEnumerationWindow(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const bucket = now - (now % 300) - 300;
  const stats = await loadWindow(env, bucket);
  const current = await env.DB.prepare(
    "SELECT * FROM security_incidents WHERE name = 'enumeration'",
  ).first<IncidentRow>();
  const action = chooseAlertAction(current ?? null, stats, now);
  const severity = signalSeverity(stats, current?.status === "open");

  let incident: IncidentRow;
  if (!current || current.status === "closed") {
    incident = {
      status: severity > 0 ? "open" : "closed",
      severity,
      opened_at: now,
      last_seen_at: severity > 0 ? now : 0,
      last_alerted_at: action ? now : 0,
      quiet_windows: 0,
      peak_addresses: stats.addresses,
      total_addresses: stats.addresses,
      total_live_hits: stats.liveHits,
      total_rate_limited: stats.rateLimited,
      vault_mask: stats.vaultMask,
    };
  } else {
    incident = {
      ...current,
      status: action === "resolve" ? "closed" : "open",
      severity: Math.max(current.severity, severity),
      last_seen_at: severity > 0 ? now : current.last_seen_at,
      last_alerted_at: action ? now : current.last_alerted_at,
      quiet_windows: severity > 0 ? 0 : current.quiet_windows + 1,
      peak_addresses: Math.max(current.peak_addresses, stats.addresses),
      total_addresses: current.total_addresses + stats.addresses,
      total_live_hits: current.total_live_hits + stats.liveHits,
      total_rate_limited: current.total_rate_limited + stats.rateLimited,
      vault_mask: current.vault_mask | stats.vaultMask,
    };
  }

  const upsertIncident = env.DB.prepare(
    `INSERT INTO security_incidents
     (name, status, severity, opened_at, last_seen_at, last_alerted_at, quiet_windows,
      peak_addresses, total_addresses, total_live_hits, total_rate_limited, vault_mask)
     VALUES ('enumeration', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET status=excluded.status, severity=excluded.severity,
      opened_at=excluded.opened_at, last_seen_at=excluded.last_seen_at,
      last_alerted_at=excluded.last_alerted_at, quiet_windows=excluded.quiet_windows,
      peak_addresses=excluded.peak_addresses, total_addresses=excluded.total_addresses,
      total_live_hits=excluded.total_live_hits, total_rate_limited=excluded.total_rate_limited,
      vault_mask=excluded.vault_mask`,
  ).bind(
    incident.status,
    incident.severity,
    incident.opened_at,
    incident.last_seen_at,
    incident.last_alerted_at,
    incident.quiet_windows,
    incident.peak_addresses,
    incident.total_addresses,
    incident.total_live_hits,
    incident.total_rate_limited,
    incident.vault_mask,
  );

  if (action) {
    const id = notificationId("enumeration", action, bucket);
    await env.DB.batch([
      upsertIncident,
      enqueueNotification(
        env,
        id,
        "enumeration",
        action,
        bucket,
        stats,
        incident,
        now,
      ),
    ]);
  } else {
    await upsertIncident.run();
  }

  await drainSecurityNotifications(env, now);

  console.log({ event: "security.enumeration_window", action, ...stats });
}

export async function sendDailySecurityDigest(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const since = now - 86400;
  const probes = await env.DB.prepare(
    `SELECT COUNT(*) AS addresses, COUNT(DISTINCT scanner_id) AS scanners,
            SUM(is_live) AS live_hits
     FROM security_probes WHERE bucket >= ?`,
  ).bind(since).first<
    { addresses: number; scanners: number; live_hits: number | null }
  >();
  if (!probes || probes.addresses === 0) {
    await drainSecurityNotifications(env, now);
    return;
  }
  const signals = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM security_signals
     WHERE bucket >= ? AND kind = 'rate_limited'`,
  ).bind(since).first<{ count: number }>();
  const day = now - (now % 86400);
  const id = notificationId("security", "daily-digest", day);
  const text = [
    "nzip security activity for the last 24 hours",
    `Distinct scanner/address pairs: ${probes.addresses}`,
    `Scanner identities: ${probes.scanners}`,
    `Live-address hits: ${probes.live_hits ?? 0}`,
    `Rate-limit confirmations: ${signals?.count ?? 0}`,
    "No digest is sent on days without bare-address probe activity.",
    `Notification ID: ${id}`,
  ].join("\n");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO security_notifications
     (id, incident_name, action, window_bucket, subject, text, html, created_at)
     VALUES (?, 'security', 'daily-digest', ?, ?, ?, NULL, ?)`,
  ).bind(
    id,
    day,
    "[nzip] Daily security activity summary",
    text,
    now,
  ).run();
  await drainSecurityNotifications(env, now);
}

export async function pruneSecurityTelemetry(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const cutoff = now - 7 * 86400;
  const notificationCutoff = now - 30 * 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM security_probes WHERE bucket < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM security_signals WHERE bucket < ?").bind(
      cutoff,
    ),
    env.DB.prepare(
      "DELETE FROM security_notifications WHERE sent_at IS NOT NULL AND sent_at < ?",
    ).bind(notificationCutoff),
  ]);
}
