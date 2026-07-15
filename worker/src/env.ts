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

function configuredSiteDomain(env: Env): string {
  const domain = env.SITE_DOMAIN.toLowerCase();
  if (
    domain.length > 253 || domain.includes("..") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
  ) {
    throw new Error("invalid SITE_DOMAIN");
  }
  return domain;
}

export function isControlOrigin(env: Env, url: URL): boolean {
  const publicUrl = new URL(env.PUBLIC_BASE);
  return url.hostname === publicUrl.hostname &&
    (url.port === "" || url.port === publicUrl.port);
}

export function siteAddressFromUrl(env: Env, url: URL): string | null {
  const publicUrl = new URL(env.PUBLIC_BASE);
  if (url.port !== "" && url.port !== publicUrl.port) {
    return null;
  }
  const suffix = `.${configuredSiteDomain(env)}`;
  if (!url.hostname.endsWith(suffix)) return null;
  const address = url.hostname.slice(0, -suffix.length);
  return /^[0-9a-f]{4}$/.test(address) ? address : null;
}

export function siteUrl(
  env: Env,
  address: string,
  pathname = "/",
  search = "",
): string {
  const url = new URL(env.PUBLIC_BASE);
  url.hostname = `${address}.${configuredSiteDomain(env)}`;
  url.pathname = pathname;
  url.search = search;
  url.hash = "";
  return url.toString();
}
