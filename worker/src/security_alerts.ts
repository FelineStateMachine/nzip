import type { Env } from "./env.ts";

export interface WindowStats {
  bucket: number;
  addresses: number;
  scanners: number;
  misses: number;
  liveHits: number;
  rateLimited: number;
  topScannerAddresses: number;
  longestSequence: number;
  vaultMask: number;
  countries: string[];
  asns: number[];
}

interface IncidentRow {
  status: "open" | "closed";
  severity: number;
  opened_at: number;
  last_seen_at: number;
  last_alerted_at: number;
  quiet_windows: number;
  peak_addresses: number;
  total_addresses: number;
  total_live_hits: number;
  total_rate_limited: number;
  vault_mask: number;
}

export type AlertAction = "open" | "escalate" | "summary" | "resolve" | null;

export function signalSeverity(
  stats: WindowStats,
  incidentOpen = false,
): number {
  const distributed = stats.addresses >= 128 && stats.scanners >= 10 &&
    (stats.addresses === 0 || stats.misses / stats.addresses >= 0.9);
  const scannerSweep = stats.topScannerAddresses >= 20;
  const suspiciousLiveHit = stats.liveHits > 0 &&
    (incidentOpen || stats.topScannerAddresses >= 8 ||
      stats.longestSequence >= 8);
  if (stats.rateLimited > 0 || suspiciousLiveHit) return 2;
  if (scannerSweep || distributed) return 1;
  return 0;
}

export function chooseAlertAction(
  incident: IncidentRow | null,
  stats: WindowStats,
  now: number,
): AlertAction {
  const severity = signalSeverity(stats, incident?.status === "open");
  if (!incident || incident.status === "closed") {
    return severity > 0 ? "open" : null;
  }
  if (severity === 0) return incident.quiet_windows >= 2 ? "resolve" : null;
  if (
    severity > incident.severity ||
    stats.addresses >= Math.max(20, incident.peak_addresses * 2) ||
    (stats.liveHits > 0 && incident.total_live_hits === 0)
  ) return "escalate";
  const reachedNewVault = (stats.vaultMask & ~incident.vault_mask) !== 0;
  if (reachedNewVault && now - incident.last_alerted_at >= 1800) {
    return "escalate";
  }
  if (now - incident.last_alerted_at >= 3600) return "summary";
  return null;
}

function longestAdjacentRun(addresses: number[]): number {
  if (addresses.length === 0) return 0;
  const sorted = [...new Set(addresses)].sort((a, b) => a - b);
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    current = sorted[i] === sorted[i - 1] + 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

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

function subject(action: Exclude<AlertAction, null>, severity: number): string {
  if (action === "resolve") return "[nzip] Enumeration incident resolved";
  if (action === "summary") return "[nzip] Enumeration incident summary";
  return `[nzip] ${
    severity >= 2 ? "Confirmed" : "Possible"
  } enumeration ${action}`;
}

function emailText(
  action: Exclude<AlertAction, null>,
  stats: WindowStats,
  incident: IncidentRow,
): string {
  const start = new Date(incident.opened_at * 1000).toISOString();
  return [
    `Enumeration incident: ${action}`,
    `Severity: ${incident.severity >= 2 ? "confirmed" : "warning"}`,
    `Opened: ${start}`,
    `This window: ${stats.addresses} distinct scanner/address pairs, ${stats.scanners} scanners`,
    `Top scanner: ${stats.topScannerAddresses} distinct addresses`,
    `Live hits: ${stats.liveHits}; rate-limited scanners: ${stats.rateLimited}`,
    `Longest adjacent run: ${stats.longestSequence}`,
    `Incident totals: ${incident.total_addresses} observations, ${incident.total_live_hits} live hits, ${incident.total_rate_limited} rate-limit confirmations`,
    `Countries: ${stats.countries.join(", ") || "unknown"}`,
    `ASNs: ${stats.asns.join(", ") || "unknown"}`,
    "Re-alert policy: immediate on escalation; otherwise at most hourly; resolves after 15 quiet minutes.",
  ].join("\n");
}

async function sendAlert(
  env: Env,
  action: Exclude<AlertAction, null>,
  stats: WindowStats,
  incident: IncidentRow,
): Promise<void> {
  const text = emailText(action, stats, incident);
  await env.EMAIL.send({
    from: { email: env.ALERT_EMAIL_FROM, name: "nzip security" },
    to: env.ALERT_EMAIL_TO,
    subject: subject(action, incident.severity),
    text,
    html:
      `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${
        text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      }</pre>`,
  });
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

  // Deliver before advancing last_alerted_at so transient failures retry on
  // the next scheduled window instead of being silently suppressed.
  if (action) await sendAlert(env, action, stats, incident);

  await env.DB.prepare(
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
  ).run();

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
  if (!probes || probes.addresses === 0) return;
  const signals = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM security_signals
     WHERE bucket >= ? AND kind = 'rate_limited'`,
  ).bind(since).first<{ count: number }>();
  const text = [
    "nzip security activity for the last 24 hours",
    `Distinct scanner/address pairs: ${probes.addresses}`,
    `Scanner identities: ${probes.scanners}`,
    `Live-address hits: ${probes.live_hits ?? 0}`,
    `Rate-limit confirmations: ${signals?.count ?? 0}`,
    "No digest is sent on days without bare-address probe activity.",
  ].join("\n");
  await env.EMAIL.send({
    from: { email: env.ALERT_EMAIL_FROM, name: "nzip security" },
    to: env.ALERT_EMAIL_TO,
    subject: "[nzip] Daily security activity summary",
    text,
  });
}

export async function sendAlertTest(env: Env): Promise<void> {
  await env.EMAIL.send({
    from: { email: env.ALERT_EMAIL_FROM, name: "nzip security" },
    to: env.ALERT_EMAIL_TO,
    subject: "[nzip] Security alert delivery test",
    text: "nzip security alert delivery is configured correctly.",
  });
}

export async function pruneSecurityTelemetry(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const cutoff = now - 7 * 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM security_probes WHERE bucket < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM security_signals WHERE bucket < ?").bind(
      cutoff,
    ),
  ]);
}
