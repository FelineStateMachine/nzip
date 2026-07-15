import type { Env } from "./env.ts";

const ADDRESS_PATH = /^\/([0-9a-f]{4})(\/.*)?$/;
const EXACT_ADDRESS_PATH = /^\/([0-9a-f]{4})\/?$/;
const UNLOCK_PATH = /^\/([0-9a-f]{4})\/__unlock$/;
const KNOWN_SERVICE_PATHS = new Set(["/", "/favicon.ico", "/robots.txt"]);
const MAX_LOGGED_PATH_LENGTH = 256;
const SCANNER_SAMPLE_RATE = 0.01;
const SAMPLE_SPACE = 0x1_0000;
const SAMPLE_CUTOFF = Math.floor(SAMPLE_SPACE * SCANNER_SAMPLE_RATE);

type RequestClass = "address" | "address_asset" | "unlock" | "api" | "invalid";

export interface SecurityRequestEvent {
  event: "security.request";
  sample_rate: number;
  path_class: RequestClass;
  path: string;
  path_truncated?: true;
  method: string;
  status: number;
  result: string;
  address?: string;
  vault_slot?: number;
  site_slot?: number;
}

function resultForStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 410) return "gone";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  if (status >= 300) return "redirect";
  return "served";
}

/** Build a bounded, low-cardinality event for requests useful in scan analysis. */
export function buildSecurityRequestEvent(
  req: Request,
  url: URL,
  response: Response,
  siteAddress: string | null = null,
): SecurityRequestEvent | null {
  const path = url.pathname;
  const unlock = path.match(UNLOCK_PATH);
  const exactAddress = path.match(EXACT_ADDRESS_PATH);
  const addressPath = path.match(ADDRESS_PATH);

  let pathClass: RequestClass;
  if (siteAddress !== null) {
    if (path === "/__unlock") {
      pathClass = "unlock";
    } else if (path === "/") {
      pathClass = "address";
    } else {
      if (response.status < 400) return null;
      pathClass = "address_asset";
    }
  } else if (path === "/api" || path.startsWith("/api/")) {
    if (response.status < 400) return null;
    pathClass = "api";
  } else if (unlock) {
    pathClass = "unlock";
  } else if (exactAddress) {
    // Bare address hits are the enumeration surface, whether they hit or miss.
    pathClass = "address";
  } else if (addressPath) {
    if (response.status < 400) return null;
    pathClass = "address_asset";
  } else {
    if (response.status < 400 || KNOWN_SERVICE_PATHS.has(path)) return null;
    pathClass = "invalid";
  }

  const address = siteAddress ?? (unlock ?? exactAddress ?? addressPath)?.[1];
  const loggedPath = path.slice(0, MAX_LOGGED_PATH_LENGTH);
  return {
    event: "security.request",
    sample_rate: SCANNER_SAMPLE_RATE,
    path_class: pathClass,
    path: loggedPath,
    ...(loggedPath.length < path.length
      ? { path_truncated: true as const }
      : {}),
    method: req.method,
    status: response.status,
    result: resultForStatus(response.status),
    ...(address
      ? {
        address,
        vault_slot: Number.parseInt(address[0], 16),
        site_slot: Number.parseInt(address.slice(1), 16),
      }
      : {}),
  };
}

export async function scannerDigest(
  ip: string,
  secret: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(ip)),
  );
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Persist a bounded, privacy-preserving record for five-minute alert evaluation. */
export async function recordEnumerationProbe(
  req: Request,
  env: Env,
  url: URL,
  response: Response,
  siteAddress: string | null = null,
): Promise<void> {
  const match = url.pathname.match(EXACT_ADDRESS_PATH);
  const addressString = siteAddress !== null && url.pathname === "/"
    ? siteAddress
    : match?.[1];
  if (!addressString) return;

  try {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    const digest = await scannerDigest(ip, env.NZIP_TOKEN);
    const scannerId = hex(digest.slice(0, 8));
    // A rejected enumeration request still carries a useful confirmation that
    // the edge limiter fired, but it must not bypass the persistence budget.
    // Keep confirmations on a separate quota so a scanner cannot turn an
    // unlimited stream of 429 responses into unlimited D1 writes.
    const persistenceLimiter = response.status === 429
      ? env.RL_SIGNAL
      : env.RL_OBSERVE;
    const { success } = await persistenceLimiter.limit({ key: scannerId });
    if (!success) return;

    const now = Math.floor(Date.now() / 1000);
    const bucket = now - (now % 300);
    const address = Number.parseInt(addressString, 16);
    const cf = req.cf;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO security_probes
       (bucket, scanner_id, address, vault_slot, is_live, country, asn)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      bucket,
      scannerId,
      address,
      address >>> 12,
      response.status < 400 ? 1 : 0,
      cf?.country ?? null,
      typeof cf?.asn === "number" ? cf.asn : null,
    ).run();

    if (response.status === 429) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO security_signals (bucket, scanner_id, kind)
         VALUES (?, ?, 'rate_limited')`,
      ).bind(bucket, scannerId).run();
    }
  } catch (error) {
    console.error({
      event: "security.recording_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Retain complete sequences for a deterministic ~1% sample of scanner identities.
 * This is more useful for enumeration detection, and much cheaper, than sampling
 * individual requests independently. The raw client IP is never logged.
 */
export async function logSecurityRequest(
  req: Request,
  env: Env,
  url: URL,
  response: Response,
  siteAddress: string | null = null,
): Promise<void> {
  const event = buildSecurityRequestEvent(req, url, response, siteAddress);
  if (!event) return;

  try {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    const digest = await scannerDigest(ip, env.NZIP_TOKEN);
    const bucket = (digest[0] << 8) | digest[1];
    if (bucket >= SAMPLE_CUTOFF) return;

    // Once a limiter has rejected a client, a flood can continue without bound.
    // Sample those repeated 429s again by request while retaining all allowed
    // probes from the selected scanner identity.
    let effectiveSampleRate = SCANNER_SAMPLE_RATE;
    if (response.status === 429) {
      const requestIdentity = req.headers.get("cf-ray") ?? crypto.randomUUID();
      const requestDigest = await scannerDigest(
        `${ip}:${requestIdentity}`,
        env.NZIP_TOKEN,
      );
      const requestBucket = (requestDigest[0] << 8) | requestDigest[1];
      if (requestBucket >= SAMPLE_CUTOFF) return;
      effectiveSampleRate *= SCANNER_SAMPLE_RATE;
    }

    const cf = req.cf;
    console.warn({
      ...event,
      sample_rate: effectiveSampleRate,
      scanner_id: hex(digest.slice(0, 8)),
      ...(cf?.country ? { country: cf.country } : {}),
      ...(cf?.colo ? { colo: cf.colo } : {}),
      ...(typeof cf?.asn === "number" ? { asn: cf.asn } : {}),
    });
  } catch (error) {
    console.error({
      event: "security.logging_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
