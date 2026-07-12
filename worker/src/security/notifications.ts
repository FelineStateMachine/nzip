import type { Env } from "../env.ts";
import type { AlertAction, IncidentRow, WindowStats } from "./policy.ts";

interface NotificationRow {
  id: string;
  subject: string;
  text: string;
  html: string | null;
  attempts: number;
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
  return [
    `Enumeration incident: ${action}`,
    `Severity: ${incident.severity >= 2 ? "confirmed" : "warning"}`,
    `Opened: ${new Date(incident.opened_at * 1000).toISOString()}`,
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

export function notificationId(
  incidentName: string,
  action: string,
  bucket: number,
): string {
  return `${incidentName}:${action}:${bucket}`;
}

export function enqueueNotification(
  env: Env,
  id: string,
  incidentName: string,
  action: Exclude<AlertAction, null>,
  bucket: number,
  stats: WindowStats,
  incident: IncidentRow,
  now: number,
): D1PreparedStatement {
  const text = `${emailText(action, stats, incident)}\nNotification ID: ${id}`;
  const html =
    `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    }</pre>`;
  return env.DB.prepare(
    `INSERT OR IGNORE INTO security_notifications
     (id, incident_name, action, window_bucket, subject, text, html, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    incidentName,
    action,
    bucket,
    subject(action, incident.severity),
    text,
    html,
    now,
  );
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}

export async function drainSecurityNotifications(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT id, subject, text, html, attempts FROM security_notifications
     WHERE sent_at IS NULL ORDER BY created_at, id LIMIT 10`,
  ).all<NotificationRow>();

  for (const notification of pending.results) {
    const attempt = notification.attempts + 1;
    try {
      await env.EMAIL.send({
        from: { email: env.ALERT_EMAIL_FROM, name: "nzip security" },
        to: env.ALERT_EMAIL_TO,
        subject: notification.subject,
        text: notification.text,
        ...(notification.html ? { html: notification.html } : {}),
      });
      await env.DB.prepare(
        `UPDATE security_notifications SET sent_at = ?, attempts = attempts + 1,
         last_error = NULL WHERE id = ? AND sent_at IS NULL`,
      ).bind(now, notification.id).run();
      console.log({
        event: "security.notification_sent",
        notificationId: notification.id,
        attempt,
      });
    } catch (error) {
      const message = errorMessage(error);
      await env.DB.prepare(
        `UPDATE security_notifications SET attempts = attempts + 1, last_error = ?
         WHERE id = ? AND sent_at IS NULL`,
      ).bind(message, notification.id).run();
      console.error({
        event: "security.notification_failed",
        notificationId: notification.id,
        attempt,
        error: message,
      });
    }
  }
}

export async function sendAlertTest(env: Env): Promise<void> {
  await env.EMAIL.send({
    from: { email: env.ALERT_EMAIL_FROM, name: "nzip security" },
    to: env.ALERT_EMAIL_TO,
    subject: "[nzip] Security alert delivery test",
    text: "nzip security alert delivery is configured correctly.",
  });
}
