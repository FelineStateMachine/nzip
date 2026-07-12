export interface Env {
  CONTENT: R2Bucket;
  DB: D1Database;
  NZIP_TOKEN: string;
  PUBLIC_BASE: string;
  // Per-IP limiter for bare-address hits — throttles address enumeration.
  RL_ENUM: RateLimit;
  // Per-IP+address limiter for the unlock endpoint — throttles password guessing.
  RL_UNLOCK: RateLimit;
}

export function json<T = unknown>(body: T, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function err(message: string, status: number): Response {
  return json({ error: message }, status, { "cache-control": "no-store" });
}

export function siteUrl(env: Env, address: string): string {
  return `${env.PUBLIC_BASE}/${address}`;
}
