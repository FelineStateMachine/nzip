import type { Env } from "./env.ts";
import { json } from "./env.ts";
import { validatePushEndpoint as validateWebPushEndpoint } from "./web_push.ts";

const CLAIM_COOKIE = "__Host-nzip-notify";
const PENDING_SECONDS = 10 * 60;
const APPROVED_SETUP_SECONDS = 24 * 60 * 60;
const CLAIM_SECONDS = 365 * 24 * 60 * 60;
const RENEW_WINDOW_SECONDS = 90 * 24 * 60 * 60;
const MAX_PENDING = 32;
const MAX_JSON_BYTES = 8 * 1024;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_RE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

export type NotifyEnv = Env & {
  NOTIFY_ENABLED?: string;
  VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_ORIGINS?: string;
  RL_NOTIFY_ENROLL?: RateLimit;
  RL_NOTIFY_READ?: RateLimit;
};

interface DeviceRow {
  id: string;
  status: string;
  name: string | null;
  user_agent_summary: string | null;
  device_class: string | null;
  country: string | null;
  region: string | null;
  asn: number | null;
  created_at: number;
  pairing_expires_at: number | null;
  claim_expires_at: number | null;
  approved_at: number | null;
  active_at: number | null;
  last_attached_at: number | null;
  last_seen_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  endpoint_hash?: string | null;
  p256dh?: string | null;
  auth?: string | null;
}

export class NotifyHttpError extends Error {
  status: number;
  headers: HeadersInit;

  constructor(
    status: number,
    message: string,
    headers: HeadersInit = {},
  ) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizePairingCode(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 8) return null;
  const normalized = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return CODE_RE.test(normalized) ? normalized : null;
}

async function hmacHex(
  secret: string,
  purpose: string,
  value: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${purpose}\0${value}`),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signingSecret(env: NotifyEnv): string {
  if (!env.NZIP_TOKEN) {
    throw new NotifyHttpError(503, "notifications unavailable");
  }
  return env.NZIP_TOKEN;
}

export function claimCookie(value: string, maxAge: number): string {
  return `${CLAIM_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearClaimCookie(): string {
  return `${CLAIM_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readClaimCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const entry of cookie.split(";")) {
    const [name, ...parts] = entry.trim().split("=");
    if (name === CLAIM_COOKIE) {
      const value = parts.join("=");
      return /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function isSameOriginBrowserRequest(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  return origin !== null || site !== null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized || [...normalized].length > max ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export async function readNotifyJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim()
    .toLowerCase();
  if (type !== "application/json") {
    throw new NotifyHttpError(415, "application/json required");
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)
  ) {
    throw new NotifyHttpError(413, "request too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new NotifyHttpError(413, "request too large");
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new NotifyHttpError(400, "invalid json");
  }
}

function userAgentSummary(request: Request): string {
  return (request.headers.get("user-agent") ?? "unknown").replace(
    /[\u0000-\u001f\u007f]/g,
    " ",
  )
    .slice(0, 200);
}

function deviceClass(userAgent: string): string {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "apple-mobile";
  if (/Android/i.test(userAgent)) return "android";
  if (/Mobile/i.test(userAgent)) return "mobile";
  return "desktop";
}

function cfMetadata(
  request: Request,
): { country: string | null; region: string | null; asn: number | null } {
  const cf = request.cf;
  return {
    country: typeof cf?.country === "string" ? cf.country.slice(0, 2) : null,
    region: typeof cf?.regionCode === "string"
      ? cf.regionCode.slice(0, 8)
      : null,
    asn: typeof cf?.asn === "number" ? cf.asn : null,
  };
}

function publicHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    "cache-control": "no-store",
    "vary": "Cookie",
    ...extra,
  };
}

function publicJson(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return json(body, status, publicHeaders(headers));
}

async function rateLimit(
  binding: RateLimit | undefined,
  key: string,
): Promise<void> {
  if (!binding) return;
  const result = await binding.limit({ key });
  if (!result.success) {
    throw new NotifyHttpError(429, "rate limited", { "retry-after": "60" });
  }
}

function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

export async function createEnrollment(
  request: Request,
  env: NotifyEnv,
): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    throw new NotifyHttpError(403, "same-origin request required");
  }
  await rateLimit(env.RL_NOTIFY_ENROLL, clientKey(request));
  await readNotifyJsonObject(request);

  const now = nowSeconds();
  await env.DB.prepare(
    "UPDATE notification_devices SET status = 'expired', pairing_code_hash = NULL, claim_hash = NULL WHERE status = 'pending' AND pairing_expires_at <= ?",
  ).bind(now).run();

  const secret = signingSecret(env);
  const claim = randomBase64Url(32);
  const claimHash = await hmacHex(secret, "notify-claim", claim);
  const userAgent = userAgentSummary(request);
  const metadata = cfMetadata(request);

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = crypto.randomUUID();
    const code = generatePairingCode();
    const codeHash = await hmacHex(secret, "notify-code", code);
    try {
      const result = await env.DB.prepare(
        `INSERT INTO notification_devices
         (id, pairing_code_hash, claim_hash, status, user_agent_summary, device_class,
          country, region, asn, created_at, pairing_expires_at, claim_expires_at)
         SELECT ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM notification_devices
                WHERE status = 'pending' AND pairing_expires_at > ?) < ?`,
      ).bind(
        id,
        codeHash,
        claimHash,
        userAgent,
        deviceClass(userAgent),
        metadata.country,
        metadata.region,
        metadata.asn,
        now,
        now + PENDING_SECONDS,
        now + PENDING_SECONDS,
        now,
        MAX_PENDING,
      ).run();
      if (result.meta.changes !== 1) {
        throw new NotifyHttpError(429, "pairing temporarily unavailable", {
          "retry-after": "60",
        });
      }
      console.log(
        JSON.stringify({ event: "notify.enrollment_created", deviceId: id }),
      );
      return publicJson(
        { code, status: "pending", expiresAt: now + PENDING_SECONDS },
        201,
        { "set-cookie": claimCookie(claim, PENDING_SECONDS) },
      );
    } catch (error) {
      if (error instanceof NotifyHttpError) throw error;
      if (
        !/unique|constraint/i.test(
          error instanceof Error ? error.message : String(error),
        )
      ) throw error;
    }
  }
  throw new NotifyHttpError(503, "pairing temporarily unavailable", {
    "retry-after": "60",
  });
}

async function currentDevice(
  request: Request,
  env: NotifyEnv,
): Promise<{ row: DeviceRow; claim: string } | null> {
  const claim = readClaimCookie(request);
  if (!claim) return null;
  const claimHash = await hmacHex(signingSecret(env), "notify-claim", claim);
  const row = await env.DB.prepare(
    `SELECT id, status, name, user_agent_summary, device_class, country, region, asn,
            created_at, pairing_expires_at, claim_expires_at, approved_at, active_at,
            last_attached_at, last_seen_at, last_success_at, last_error,
            endpoint_hash, p256dh, auth
     FROM notification_devices WHERE claim_hash = ?`,
  ).bind(claimHash).first<DeviceRow>();
  return row ? { row, claim } : null;
}

export async function authorizeNotificationClaim(
  request: Request,
  env: NotifyEnv,
): Promise<boolean> {
  const current = await currentDevice(request, env);
  const now = nowSeconds();
  return current !== null &&
    ["approved", "active"].includes(current.row.status) &&
    (current.row.claim_expires_at ?? 0) > now;
}

function publicState(row: DeviceRow, now: number): Record<string, unknown> {
  if (row.status === "pending" && (row.pairing_expires_at ?? 0) <= now) {
    return { status: "expired" };
  }
  if (["revoked", "expired", "disabled"].includes(row.status)) {
    return { status: row.status };
  }
  return {
    status: row.status,
    paired: row.status === "approved" || row.status === "active",
    notifications: row.status === "active" ? "on" : "off",
    claimExpiresAt: row.claim_expires_at,
  };
}

export async function getCurrentEnrollment(
  request: Request,
  env: NotifyEnv,
): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    throw new NotifyHttpError(403, "same-origin request required");
  }
  const current = await currentDevice(request, env);
  if (!current) return publicJson({ status: "unpaired" });
  await rateLimit(env.RL_NOTIFY_READ, current.row.id);
  const now = nowSeconds();
  if (
    (current.row.claim_expires_at ?? 0) <= now &&
    current.row.status !== "pending"
  ) {
    return publicJson({ status: "expired" }, 200, {
      "set-cookie": clearClaimCookie(),
    });
  }
  return publicJson(publicState(current.row, now));
}

export async function activateEnrollment(
  request: Request,
  env: NotifyEnv,
): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    throw new NotifyHttpError(403, "same-origin request required");
  }
  await readNotifyJsonObject(request);
  const current = await currentDevice(request, env);
  const now = nowSeconds();
  if (
    !current || current.row.status !== "approved" ||
    (current.row.claim_expires_at ?? 0) <= now
  ) {
    throw new NotifyHttpError(404, "pairing unavailable");
  }
  const expiry = now + CLAIM_SECONDS;
  const result = await env.DB.prepare(
    "UPDATE notification_devices SET claim_expires_at = ?, last_seen_at = ? WHERE id = ? AND status = 'approved'",
  ).bind(expiry, now, current.row.id).run();
  if (result.meta.changes !== 1) {
    throw new NotifyHttpError(404, "pairing unavailable");
  }
  return publicJson(
    {
      status: "approved",
      paired: true,
      notifications: "off",
      claimExpiresAt: expiry,
    },
    200,
    { "set-cookie": claimCookie(current.claim, CLAIM_SECONDS) },
  );
}

export async function renewEnrollment(
  request: Request,
  env: NotifyEnv,
): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    throw new NotifyHttpError(403, "same-origin request required");
  }
  await readNotifyJsonObject(request);
  const current = await currentDevice(request, env);
  const now = nowSeconds();
  if (
    !current || !["approved", "active"].includes(current.row.status) ||
    (current.row.claim_expires_at ?? 0) <= now
  ) {
    throw new NotifyHttpError(404, "pairing unavailable");
  }
  const remaining = (current.row.claim_expires_at ?? 0) - now;
  if (remaining >= RENEW_WINDOW_SECONDS) {
    return publicJson(publicState(current.row, now));
  }
  const expiry = now + CLAIM_SECONDS;
  await env.DB.prepare(
    "UPDATE notification_devices SET claim_expires_at = ?, last_seen_at = ? WHERE id = ? AND status IN ('approved', 'active')",
  ).bind(expiry, now, current.row.id).run();
  return publicJson(
    { ...publicState(current.row, now), claimExpiresAt: expiry },
    200,
    { "set-cookie": claimCookie(current.claim, CLAIM_SECONDS) },
  );
}

interface SubscriptionBody {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export function validateSubscriptionEndpoint(
  endpoint: string,
  env: NotifyEnv,
): URL {
  try {
    return validateWebPushEndpoint(env, endpoint);
  } catch (_error) {
    throw new NotifyHttpError(400, "invalid subscription");
  }
}

function validSubscription(
  value: Record<string, unknown>,
): SubscriptionBody | null {
  const endpoint = boundedText(value.endpoint, 2048);
  const keys = value.keys;
  const expirationTime = value.expirationTime;
  if (
    !endpoint || typeof keys !== "object" || keys === null ||
    Array.isArray(keys) ||
    !(expirationTime === null ||
      (typeof expirationTime === "number" &&
        Number.isSafeInteger(expirationTime)))
  ) {
    return null;
  }
  const typedKeys = keys as Record<string, unknown>;
  const p256dh = boundedText(typedKeys.p256dh, 256);
  const auth = boundedText(typedKeys.auth, 128);
  if (
    !p256dh || !auth || !/^[A-Za-z0-9_-]+$/.test(p256dh) ||
    !/^[A-Za-z0-9_-]+$/.test(auth)
  ) {
    return null;
  }
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

export async function attachSubscription(
  request: Request,
  env: NotifyEnv,
): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    throw new NotifyHttpError(403, "same-origin request required");
  }
  const body = validSubscription(await readNotifyJsonObject(request));
  if (!body) throw new NotifyHttpError(400, "invalid subscription");
  const endpoint = validateSubscriptionEndpoint(body.endpoint, env).toString();
  const current = await currentDevice(request, env);
  const now = nowSeconds();
  if (
    !current || !["approved", "active"].includes(current.row.status) ||
    (current.row.claim_expires_at ?? 0) <= now
  ) {
    throw new NotifyHttpError(404, "pairing unavailable");
  }
  const endpointHash = await hmacHex(
    signingSecret(env),
    "notify-endpoint",
    endpoint,
  );
  if (
    current.row.endpoint_hash === endpointHash &&
    current.row.p256dh === body.keys.p256dh &&
    current.row.auth === body.keys.auth
  ) {
    await env.DB.prepare(
      "UPDATE notification_devices SET last_seen_at = ? WHERE id = ?",
    ).bind(
      now,
      current.row.id,
    ).run();
  } else {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE notification_devices SET status = 'disabled', endpoint = NULL,
         endpoint_hash = NULL, p256dh = NULL, auth = NULL, last_error = 'endpoint_reassigned'
         WHERE endpoint_hash = ? AND id <> ?`,
      ).bind(endpointHash, current.row.id),
      env.DB.prepare(
        `UPDATE notification_devices SET status = 'active', endpoint = ?, endpoint_hash = ?,
         p256dh = ?, auth = ?, active_at = COALESCE(active_at, ?), last_attached_at = ?,
         last_seen_at = ?, last_error = NULL
         WHERE id = ? AND status IN ('approved', 'active')`,
      ).bind(
        endpoint,
        endpointHash,
        body.keys.p256dh,
        body.keys.auth,
        now,
        now,
        now,
        current.row.id,
      ),
    ]);
  }
  console.log(
    JSON.stringify({
      event: "notify.subscription_attached",
      deviceId: current.row.id,
    }),
  );
  return publicJson({ status: "active", paired: true, notifications: "on" });
}

export async function detachSubscription(
  request: Request,
  env: NotifyEnv,
): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) {
    throw new NotifyHttpError(403, "same-origin request required");
  }
  const current = await currentDevice(request, env);
  const now = nowSeconds();
  if (
    !current || !["approved", "active"].includes(current.row.status) ||
    (current.row.claim_expires_at ?? 0) <= now
  ) {
    throw new NotifyHttpError(404, "pairing unavailable");
  }
  await env.DB.prepare(
    `UPDATE notification_devices SET status = 'approved', endpoint = NULL,
     endpoint_hash = NULL, p256dh = NULL, auth = NULL, last_seen_at = ?, last_error = NULL
     WHERE id = ? AND status IN ('approved', 'active')`,
  ).bind(now, current.row.id).run();
  return publicJson({ status: "approved", paired: true, notifications: "off" });
}

async function codeHash(env: NotifyEnv, raw: string): Promise<string | null> {
  const code = normalizePairingCode(raw);
  return code ? await hmacHex(signingSecret(env), "notify-code", code) : null;
}

function genericApprovalError(): never {
  throw new NotifyHttpError(404, "pairing code unavailable");
}

function ownerDevice(row: DeviceRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    pairingExpiresAt: row.pairing_expires_at,
    claimExpiresAt: row.claim_expires_at,
    approvedAt: row.approved_at,
    deviceClass: row.device_class,
    userAgentSummary: row.user_agent_summary,
    country: row.country,
    region: row.region,
    asn: row.asn,
    activeAt: row.active_at,
    lastSeenAt: row.last_seen_at,
    lastAttachedAt: row.last_attached_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  };
}

export async function previewApproval(
  rawCode: string,
  env: NotifyEnv,
): Promise<Response> {
  const hash = await codeHash(env, rawCode);
  if (!hash) return genericApprovalError();
  const now = nowSeconds();
  const row = await env.DB.prepare(
    `SELECT id, status, name, user_agent_summary, device_class, country, region, asn,
            created_at, pairing_expires_at, claim_expires_at, approved_at, active_at,
            last_attached_at, last_seen_at, last_success_at, last_error
     FROM notification_devices
     WHERE pairing_code_hash = ? AND status = 'pending' AND pairing_expires_at > ?`,
  ).bind(hash, now).first<DeviceRow>();
  if (!row) return genericApprovalError();
  return json(
    {
      createdAt: row.created_at,
      userAgentSummary: row.user_agent_summary,
      deviceClass: row.device_class,
      country: row.country,
      region: row.region,
      asn: row.asn,
    },
    200,
    { "cache-control": "no-store" },
  );
}

export async function approveEnrollment(
  request: Request,
  env: NotifyEnv,
): Promise<Response> {
  const body = await readNotifyJsonObject(request);
  const rawCode = boundedText(body.code, 32);
  const name = boundedText(body.name, 80);
  if (!rawCode || !name) {
    throw new NotifyHttpError(400, "code and name required");
  }
  const hash = await codeHash(env, rawCode);
  if (!hash) return genericApprovalError();
  const now = nowSeconds();
  const pending = await env.DB.prepare(
    "SELECT id FROM notification_devices WHERE pairing_code_hash = ? AND status = 'pending' AND pairing_expires_at > ?",
  ).bind(hash, now).first<{ id: string }>();
  if (!pending) return genericApprovalError();
  const result = await env.DB.prepare(
    `UPDATE notification_devices SET status = 'approved', name = ?, pairing_code_hash = NULL,
     approved_at = ?, claim_expires_at = ?
     WHERE id = ? AND pairing_code_hash = ? AND status = 'pending' AND pairing_expires_at > ?`,
  ).bind(name, now, now + APPROVED_SETUP_SECONDS, pending.id, hash, now).run();
  if (result.meta.changes !== 1) return genericApprovalError();
  const row = await env.DB.prepare(
    `SELECT id, status, name, user_agent_summary, device_class, country, region, asn,
            created_at, pairing_expires_at, claim_expires_at, approved_at, active_at,
            last_attached_at, last_seen_at, last_success_at, last_error
     FROM notification_devices WHERE id = ?`,
  ).bind(pending.id).first<DeviceRow>();
  if (!row) throw new NotifyHttpError(500, "internal error");
  console.log(JSON.stringify({ event: "notify.device_approved" }));
  return json(ownerDevice(row), 200, { "cache-control": "no-store" });
}

export async function listNotificationDevices(
  env: NotifyEnv,
): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, status, name, user_agent_summary, device_class, country, region, asn,
            created_at, pairing_expires_at, claim_expires_at, approved_at, active_at,
            last_attached_at, last_seen_at, last_success_at, last_error
     FROM notification_devices ORDER BY created_at DESC LIMIT 100`,
  ).all<DeviceRow>();
  return json(rows.results.map(ownerDevice), 200, {
    "cache-control": "no-store",
  });
}

export async function revokeNotificationDevice(
  id: string,
  env: NotifyEnv,
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new NotifyHttpError(404, "device not found");
  }
  const result = await env.DB.prepare(
    `UPDATE notification_devices SET status = 'revoked', pairing_code_hash = NULL,
     claim_hash = NULL, endpoint = NULL, endpoint_hash = NULL, p256dh = NULL, auth = NULL,
     last_error = NULL, last_seen_at = ? WHERE id = ? AND status <> 'revoked'`,
  ).bind(Math.floor(Date.now() / 1000), id).run();
  if (result.meta.changes !== 1) {
    throw new NotifyHttpError(404, "device not found");
  }
  console.log(JSON.stringify({ event: "notify.device_revoked", deviceId: id }));
  return json({ ok: true, deviceId: id }, 200, { "cache-control": "no-store" });
}

export function notifyErrorResponse(error: unknown): Response {
  if (error instanceof NotifyHttpError) {
    return json({ error: error.message }, error.status, {
      "cache-control": "no-store",
      ...error.headers,
    });
  }
  console.error(
    JSON.stringify({ event: "notify.request_failed", error: "internal" }),
  );
  return json({ error: "internal error" }, 500, {
    "cache-control": "no-store",
  });
}
