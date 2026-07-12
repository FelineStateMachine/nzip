import type { NotifyRequest, NotifyResponse } from "../../shared/mod.ts";
import { ApiError } from "./api/errors.ts";
import type { Env } from "./env.ts";
import { json } from "./env.ts";
import { sendWebPush } from "./web_push.ts";

interface DeviceSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface DeliveryRow extends DeviceSubscriptionRow {
  event_id: string;
  title: string;
  body: string;
  path: string | null;
  tag: string | null;
  attempts: number;
}

const RETRY_DELAYS = [300, 900, 3600, 21600] as const;

function scalarLength(value: string): number {
  return [...value].length;
}

function boundedString(
  value: unknown,
  name: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") {
    throw new ApiError(400, `${name} must be a string`);
  }
  const length = scalarLength(value);
  if (length < min || length > max) {
    throw new ApiError(400, `${name} must be ${min}-${max} characters`);
  }
  return value;
}

function normalizePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const path = boundedString(value, "path", 1, 128);
  if (
    !path.startsWith("/") || path.startsWith("//") || path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) throw new ApiError(400, "path must be a same-origin absolute path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new ApiError(400, "path has invalid encoding");
  }
  if (decoded !== path || !/^\/(?:[0-9a-f]{4})?$/.test(path)) {
    throw new ApiError(400, "path must be / or an existing nzip site path");
  }
  return path;
}

export function validateNotifyRequest(value: unknown): NotifyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "request body must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["title", "body", "path", "tag"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "request contains unknown fields");
  }
  const body = boundedString(record.body, "body", 1, 240);
  const title = record.title === undefined
    ? undefined
    : boundedString(record.title, "title", 1, 80);
  const path = normalizePath(record.path);
  let tag: string | undefined;
  if (record.tag !== undefined) {
    tag = boundedString(record.tag, "tag", 1, 64);
    if (!/^[A-Za-z0-9._:-]+$/.test(tag)) {
      throw new ApiError(400, "tag is invalid");
    }
  }
  const request = {
    body,
    ...(title ? { title } : {}),
    ...(path ? { path } : {}),
    ...(tag ? { tag } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 2048) {
    throw new ApiError(400, "notification payload is too large");
  }
  return request;
}

async function readJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
  ) {
    throw new ApiError(415, "content-type must be application/json");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 4096) {
    throw new ApiError(413, "request too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 4096) {
    throw new ApiError(413, "request too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid JSON");
  }
}

export async function handleNotifySend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (env.NOTIFY_ENABLED !== "true") {
    throw new ApiError(503, "notifications are disabled");
  }
  const input = validateNotifyRequest(await readJson(request));
  const now = Math.floor(Date.now() / 1000);
  let manifestHash: string | null = null;
  if (input.path && input.path !== "/") {
    const address = Number.parseInt(input.path.slice(1), 16);
    const site = await env.DB.prepare(
      "SELECT current_manifest FROM sites WHERE address = ?",
    ).bind(address).first<{ current_manifest: string }>();
    if (!site) throw new ApiError(400, "notification target site not found");
    manifestHash = site.current_manifest;
  }
  const devices = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth FROM notification_devices
     WHERE status = 'active' AND endpoint IS NOT NULL`,
  ).all<DeviceSubscriptionRow>();
  const inactive = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM notification_devices WHERE status <> 'active'",
  ).first<{ count: number }>();
  const eventId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      `INSERT INTO notification_events
       (id, title, body, path, expected_manifest_hash, tag, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      eventId,
      input.title ?? "nzip",
      input.body,
      input.path ?? null,
      manifestHash,
      input.tag ?? null,
      now,
    ),
    ...devices.results.map((device) =>
      env.DB.prepare(
        `INSERT INTO notification_deliveries
         (event_id, device_id, status, attempts, next_attempt_at)
         VALUES (?, ?, 'pending', 0, ?)`,
      ).bind(eventId, device.id, now)
    ),
  ];
  await env.DB.batch(statements);
  ctx.waitUntil(drainNotifications(env, now));
  const response: NotifyResponse = {
    eventId,
    queuedDevices: devices.results.length,
    inactiveDevices: inactive?.count ?? 0,
  };
  console.log({
    event: "notify.event_accepted",
    eventId,
    queuedDevices: response.queuedDevices,
  });
  return json(response, 202);
}

function classify(status: number): "sent" | "disabled" | "retry" | "failed" {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "disabled";
  if (status === 429 || status >= 500) return "retry";
  return "failed";
}

export async function drainNotifications(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (env.NOTIFY_ENABLED !== "true") return;
  const candidates = await env.DB.prepare(
    `SELECT d.event_id, d.device_id AS id, d.attempts, e.title, e.body, e.path, e.tag,
            v.endpoint, v.p256dh, v.auth
     FROM notification_deliveries d
     JOIN notification_events e ON e.id = d.event_id
     JOIN notification_devices v ON v.id = d.device_id AND v.status = 'active'
     WHERE ((d.status IN ('pending','retry') AND COALESCE(d.next_attempt_at,0) <= ?)
        OR (d.status = 'sending' AND d.lease_expires_at < ?))
     ORDER BY COALESCE(d.next_attempt_at,0) LIMIT 25`,
  ).bind(now, now).all<DeliveryRow>();
  const owner = crypto.randomUUID();
  for (const row of candidates.results) {
    const attemptStartedAt = Math.floor(Date.now() / 1000);
    const claim = await env.DB.prepare(
      `UPDATE notification_deliveries SET status='sending', lease_owner=?, lease_expires_at=?
       WHERE event_id=? AND device_id=? AND
       ((status IN ('pending','retry') AND COALESCE(next_attempt_at,0) <= ?)
        OR (status='sending' AND lease_expires_at < ?))`,
    ).bind(
      owner,
      attemptStartedAt + 60,
      row.event_id,
      row.id,
      attemptStartedAt,
      attemptStartedAt,
    ).run();
    if (claim.meta.changes !== 1) continue;
    let outcome: "sent" | "disabled" | "retry" | "failed" = "retry";
    let errorClass = "network";
    let retryAfter: number | null = null;
    try {
      const result = await sendWebPush(env, {
        endpoint: row.endpoint,
        expirationTime: null,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }, {
        eventId: row.event_id,
        title: row.title,
        body: row.body,
        ...(row.path ? { path: row.path } : {}),
        ...(row.tag ? { tag: row.tag } : {}),
      });
      outcome = classify(result.status);
      errorClass = `http_${result.status}`;
      retryAfter = result.retryAfter;
    } catch {
      outcome = "retry";
    }
    const attempts = row.attempts + 1;
    const completedAt = Math.floor(Date.now() / 1000);
    if (outcome === "disabled") {
      const terminal = await env.DB.prepare(
        `UPDATE notification_deliveries SET status='failed', attempts=?, last_error=?, lease_owner=NULL,
         lease_expires_at=NULL WHERE event_id=? AND device_id=? AND status='sending' AND lease_owner=?`,
      ).bind(attempts, errorClass, row.event_id, row.id, owner).run();
      if (terminal.meta.changes === 1) {
        await env.DB.prepare(
          `UPDATE notification_devices SET status='disabled', endpoint=NULL, endpoint_hash=NULL,
           p256dh=NULL, auth=NULL, last_error=? WHERE id=? AND status='active'`,
        ).bind(errorClass, row.id).run();
      }
    } else if (outcome === "sent") {
      const terminal = await env.DB.prepare(
        `UPDATE notification_deliveries SET status='sent', attempts=?, sent_at=?, last_error=NULL,
         lease_owner=NULL, lease_expires_at=NULL WHERE event_id=? AND device_id=? AND status='sending' AND lease_owner=?`,
      ).bind(attempts, completedAt, row.event_id, row.id, owner).run();
      if (terminal.meta.changes === 1) {
        await env.DB.prepare(
          "UPDATE notification_devices SET last_success_at=?, last_error=NULL WHERE id=? AND status='active'",
        ).bind(completedAt, row.id).run();
      }
    } else if (outcome === "retry" && attempts < 5) {
      const delay = retryAfter ??
        RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
      await env.DB.prepare(
        `UPDATE notification_deliveries SET status='retry', attempts=?, next_attempt_at=?, last_error=?,
         lease_owner=NULL, lease_expires_at=NULL WHERE event_id=? AND device_id=? AND status='sending' AND lease_owner=?`,
      ).bind(
        attempts,
        completedAt + delay,
        errorClass,
        row.event_id,
        row.id,
        owner,
      )
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE notification_deliveries SET status='failed', attempts=?, last_error=?, lease_owner=NULL,
         lease_expires_at=NULL WHERE event_id=? AND device_id=? AND status='sending' AND lease_owner=?`,
      ).bind(attempts, errorClass, row.event_id, row.id, owner).run();
    }
    console.log({
      event: `notify.delivery_${outcome}`,
      eventId: row.event_id,
      deviceId: row.id,
      attempts,
    });
  }
}

export async function validateClickTarget(
  env: Env,
  eventId: string,
): Promise<string | null> {
  const event = await env.DB.prepare(
    `SELECT path, expected_manifest_hash FROM notification_events
     WHERE id=? AND created_at >= ?`,
  ).bind(eventId, Math.floor(Date.now() / 1000) - 7 * 86400).first<{
    path: string | null;
    expected_manifest_hash: string | null;
  }>();
  if (!event?.path || event.path === "/") return event?.path ?? null;
  const site = await env.DB.prepare(
    "SELECT current_manifest FROM sites WHERE address=?",
  )
    .bind(Number.parseInt(event.path.slice(1), 16)).first<
    { current_manifest: string }
  >();
  return site?.current_manifest === event.expected_manifest_hash
    ? event.path
    : null;
}

export async function pruneNotifications(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notification_events WHERE created_at < ?").bind(
      now - 7 * 86400,
    ),
    env.DB.prepare(
      "UPDATE notification_devices SET status='expired', claim_hash=NULL, pairing_code_hash=NULL, last_seen_at=? WHERE status='pending' AND pairing_expires_at < ?",
    ).bind(now, now),
    env.DB.prepare(
      "UPDATE notification_devices SET status='expired', claim_hash=NULL, pairing_code_hash=NULL, last_seen_at=? WHERE status='approved' AND active_at IS NULL AND claim_expires_at < ?",
    ).bind(now, now),
    env.DB.prepare(
      "DELETE FROM notification_devices WHERE status IN ('revoked','expired') AND last_seen_at < ?",
    ).bind(now - 7 * 86400),
  ]);
}
