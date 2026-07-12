import webPush, { type PushSubscription } from "web-push";
import type { Env } from "./env.ts";

export interface WebPushMessage {
  eventId: string;
  title: string;
  body: string;
  path?: string;
  tag?: string;
}

export interface WebPushResult {
  status: number;
  retryAfter: number | null;
}

export interface WebPushRequest {
  endpoint: URL;
  headers: Record<string, string>;
  body: Uint8Array;
}

function configuredOrigins(env: Env): URL[] {
  const raw = env.WEB_PUSH_ORIGINS?.trim();
  if (!raw) throw new Error("web push origins are not configured");
  return raw.split(",").map((value) => {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.pathname !== "/" || url.search || url.port
    ) {
      throw new Error("invalid web push origin configuration");
    }
    return url;
  });
}

function isIpLiteral(hostname: string): boolean {
  return /^\[.*\]$/.test(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname) ||
    /^0x/i.test(hostname) || /^\d+$/.test(hostname);
}

export function validatePushEndpoint(env: Env, endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("invalid push subscription endpoint");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash ||
    url.port || isIpLiteral(url.hostname)
  ) {
    throw new Error("invalid push subscription endpoint");
  }
  const publicBase = new URL(env.PUBLIC_BASE);
  if (url.hostname === publicBase.hostname) {
    throw new Error("push subscription endpoint cannot target this deployment");
  }
  const allowed = configuredOrigins(env).some((origin) =>
    origin.origin === url.origin
  );
  if (!allowed) throw new Error("push subscription provider is not allowed");
  return url;
}

export function buildWebPushRequest(
  env: Env,
  subscription: PushSubscription,
  message: WebPushMessage,
): WebPushRequest {
  const endpoint = validatePushEndpoint(env, subscription.endpoint);
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error("VAPID is not configured");
  }
  const details = webPush.generateRequestDetails(
    subscription,
    JSON.stringify(message),
    {
      TTL: 6 * 60 * 60,
      urgency: "normal",
      contentEncoding: "aes128gcm",
      vapidDetails: {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
    },
  );
  if (!details.body) throw new Error("web push payload was not generated");
  return {
    endpoint,
    headers: details.headers,
    body: new Uint8Array(details.body),
  };
}

export async function sendWebPush(
  env: Env,
  subscription: PushSubscription,
  message: WebPushMessage,
): Promise<WebPushResult> {
  const request = buildWebPushRequest(env, subscription, message);
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
    ? Math.min(Number(retryAfterHeader), 6 * 60 * 60)
    : null;
  return { status: response.status, retryAfter };
}
