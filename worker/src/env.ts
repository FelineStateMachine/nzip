// Generated from wrangler.jsonc by `npm run types`.
export type Env = Cloudflare.Env;

export function json<T = unknown>(
  body: T,
  status = 200,
  headers: HeadersInit = {},
): Response {
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
