export interface Env {
  CONTENT: R2Bucket;
  DB: D1Database;
  NZIP_TOKEN: string;
  PUBLIC_BASE: string;
}

export function json<T = unknown>(body: T, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

export function siteUrl(env: Env, address: string): string {
  return `${env.PUBLIC_BASE}/${address}`;
}
