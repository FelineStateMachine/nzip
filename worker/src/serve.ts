import { parseAddress, parseManifest } from "../../shared/mod.ts";
import { getSiteByAddress, type SiteRow } from "./db.ts";
import { siteCacheTag } from "./cache.ts";
import type { Env } from "./env.ts";
import { siteUrl } from "./env.ts";
import { FAVICON_PNG } from "./favicon.ts";
import {
  hasValidUnlockCookie,
  makeUnlockCookie,
  verifyPassword,
} from "./password.ts";
import { notifyLandingPage } from "./notify_ui.ts";

const GONE_PAGE =
  `<!doctype html><meta charset="utf-8"><title>expired — nzip</title>
<style>body{background:#121110;color:#8a8172;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}b{color:#ffb347;font-size:32px;display:block;margin-bottom:8px}</style>
<div><b>410</b>this share expired</div>`;

const NOT_FOUND_PAGE =
  `<!doctype html><meta charset="utf-8"><title>not found — nzip</title>
<style>body{background:#121110;color:#8a8172;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}b{color:#ffb347;font-size:32px;display:block;margin-bottom:8px}</style>
<div><b>404</b>nothing here</div>`;

const MAX_UNLOCK_BODY_BYTES = 4096;
const MAX_PASSWORD_LENGTH = 256;
const ARTIFACT_SECURITY_HEADERS = {
  "permissions-policy": "document-domain=()",
} as const;

function htmlResponse(
  body: string,
  status: number,
  headers: HeadersInit = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function publicSiteHeaders(address: string): HeadersInit {
  return {
    "cache-control": "public, max-age=60",
    "cache-tag": siteCacheTag(address),
    ...ARTIFACT_SECURITY_HEADERS,
  };
}

function publicSiteRedirect(
  env: Env,
  pathname: string,
  search: string,
  address: string,
  status = 302,
): Response {
  return new Response(null, {
    status,
    headers: {
      location: siteUrl(env, address, pathname, search),
      ...publicSiteHeaders(address),
    },
  });
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function unlockForm(address: string, returnTo: string, error?: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"><meta name="robots" content="noindex"><title>unlock — nzip</title>
<style>*{box-sizing:border-box}body{background:#121110;color:#d6cfc2;font-family:ui-monospace,monospace;display:grid;place-items:center;min-height:100vh;min-height:100dvh;margin:0;padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}form{width:min(100%,420px);text-align:center}b{color:#ffb347;font-size:24px;display:block;margin-bottom:20px}.field{display:flex;width:100%}input{background:#1a1815;border:1px solid #2e2a24;color:#d6cfc2;min-width:0;flex:1;padding:12px 14px;font:inherit;font-size:16px;line-height:20px;outline:none;border-radius:0}input:focus{border-color:#ffb347}button{background:#ffb347;border:0;color:#121110;min-height:46px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer;border-radius:0}.e{color:#f7768e;margin-top:12px;font-size:13px}@media(max-width:360px){.field{display:grid;gap:10px}button{width:100%}}</style>
<form method="post" action="/__unlock"><input type="hidden" name="return_to" value="${
    escapeHtmlAttribute(returnTo)
  }"><b>&#128274; ${address}</b><div class="field"><input type="password" name="password" aria-label="password" placeholder="password" maxlength="256" autofocus autocomplete="current-password"><button>unlock</button></div>${
    error ? `<div class="e">${error}</div>` : ""
  }</form>`;
}

function unlockReturnTarget(
  req: Request,
  returnTo: string | null,
): string {
  const fallback = "/";
  if (!returnTo) return fallback;

  try {
    const requestUrl = new URL(req.url);
    const target = new URL(returnTo, requestUrl);
    if (
      target.origin !== requestUrl.origin ||
      target.pathname === "/__unlock"
    ) {
      return fallback;
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return fallback;
  }
}

async function handleUnlock(
  req: Request,
  env: Env,
  site: SiteRow,
  address: string,
): Promise<Response> {
  const fallbackTarget = "/";
  const contentLength = req.headers.get("content-length");
  if (contentLength === null) {
    return htmlResponse(
      unlockForm(address, fallbackTarget, "request size required"),
      411,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  const declaredBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
    return htmlResponse(
      unlockForm(address, fallbackTarget, "invalid request size"),
      400,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  if (declaredBytes > MAX_UNLOCK_BODY_BYTES) {
    return htmlResponse(
      unlockForm(address, fallbackTarget, "request too large"),
      413,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_UNLOCK_BODY_BYTES) {
    return htmlResponse(
      unlockForm(address, fallbackTarget, "request too large"),
      413,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  if (bytes.length !== declaredBytes) {
    return htmlResponse(
      unlockForm(address, fallbackTarget, "request size mismatch"),
      400,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    return htmlResponse(
      unlockForm(address, fallbackTarget, "unsupported form"),
      415,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  const password = form.get("password");
  const returnTarget = unlockReturnTarget(req, form.get("return_to"));
  if (password !== null && password.length > MAX_PASSWORD_LENGTH) {
    return htmlResponse(
      unlockForm(address, returnTarget, "password too long"),
      400,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  if (
    typeof password !== "string" || !site.password_hash ||
    !(await verifyPassword(password, site.password_hash))
  ) {
    return htmlResponse(
      unlockForm(address, returnTarget, "wrong password"),
      401,
      ARTIFACT_SECURITY_HEADERS,
    );
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: returnTarget,
      "set-cookie": await makeUnlockCookie(env, address, site.auth_version),
      ...ARTIFACT_SECURITY_HEADERS,
    },
  });
}

async function serveControlOrigin(
  env: Env,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  if (path === "/") {
    return htmlResponse(notifyLandingPage(env), 200, {
      "cache-control": "public, max-age=3600",
      "content-security-policy": "frame-ancestors 'none'",
      "x-frame-options": "DENY",
    });
  }
  // Served for the browsers' default probe; pushed sites under /{4hex}/ still
  // control their own icons through their HTML. PNG bytes at the .ico path are
  // accepted everywhere.
  if (path === "/favicon.ico") {
    return new Response(FAVICON_PNG, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    });
  }
  if (path === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /\n", {
      headers: {
        "content-type": "text/plain",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  // Legacy share URLs remain stable, but artifact bytes never execute on the
  // control origin. A 308 preserves method and body for stale unlock forms.
  const m = path.match(/^\/([0-9a-f]{4})(\/.*)?$/);
  if (!m) return htmlResponse(NOT_FOUND_PAGE, 404);
  const addressStr = m[1];

  const site = await getSiteByAddress(env, parseAddress(addressStr));
  if (!site) return htmlResponse(NOT_FOUND_PAGE, 404);
  return publicSiteRedirect(
    env,
    m[2] ?? "/",
    url.search,
    addressStr,
    308,
  );
}

async function serveSiteOrigin(
  req: Request,
  env: Env,
  url: URL,
  addressStr: string,
): Promise<Response> {
  const path = url.pathname;
  const site = await getSiteByAddress(env, parseAddress(addressStr));
  if (!site) {
    return htmlResponse(NOT_FOUND_PAGE, 404, ARTIFACT_SECURITY_HEADERS);
  }
  const now = Math.floor(Date.now() / 1000);
  if (site.expires_at !== null && site.expires_at < now) {
    return htmlResponse(GONE_PAGE, 410, ARTIFACT_SECURITY_HEADERS);
  }

  // Password gate.
  if (path === "/__unlock" && req.method === "POST") {
    return await handleUnlock(req, env, site, addressStr);
  }
  if (
    site.password_hash &&
    !(await hasValidUnlockCookie(req, env, addressStr, site.auth_version))
  ) {
    return htmlResponse(
      unlockForm(addressStr, `${url.pathname}${url.search}`),
      401,
      ARTIFACT_SECURITY_HEADERS,
    );
  }

  const manifestObj = await env.CONTENT.get(
    `manifest/${site.current_manifest}`,
  );
  if (!manifestObj) {
    return htmlResponse(NOT_FOUND_PAGE, 404, ARTIFACT_SECURITY_HEADERS);
  }
  const manifest = parseManifest(
    new Uint8Array(await manifestObj.arrayBuffer()),
  );
  const filePaths = Object.keys(manifest.files);

  let assetPath: string;
  let explicitIndexPath = false;
  if (path === "/") {
    assetPath = manifest.files["index.html"]
      ? "index.html"
      : filePaths.length === 1
      ? filePaths[0]
      : "index.html";
  } else {
    try {
      assetPath = decodeURIComponent(path.slice(1));
    } catch {
      return htmlResponse(NOT_FOUND_PAGE, 404, ARTIFACT_SECURITY_HEADERS);
    }
    explicitIndexPath = /(^|\/)index\.html$/.test(assetPath);
    if (assetPath === "" || assetPath.endsWith("/")) assetPath += "index.html";
  }

  // Sites built for the former /{address}/ deployment base may contain absolute
  // asset URLs with that prefix. Prefer a real file at the requested path, then
  // fall back to stripping exactly this site's address so existing artifacts
  // remain usable after moving to their own origin.
  let entry = manifest.files[assetPath];
  if (!entry) {
    const legacyPrefix = `${addressStr}/`;
    const legacyPath = assetPath === addressStr
      ? "index.html"
      : assetPath.startsWith(legacyPrefix)
      ? assetPath.slice(legacyPrefix.length) || "index.html"
      : null;
    if (legacyPath !== null) entry = manifest.files[legacyPath];
  }

  // Keep directory index filenames out of public URLs. Static generators often
  // emit same-page and anchor links as `index.html` or `index.html#section`;
  // browsers preserve the fragment while following this redirect.
  if (explicitIndexPath && entry) {
    const canonicalPath = assetPath === "index.html"
      ? "/"
      : path.slice(0, -"index.html".length);
    return publicSiteRedirect(env, canonicalPath, url.search, addressStr);
  }

  let directoryIndex = manifest.files[`${assetPath}/index.html`];
  if (!entry && !directoryIndex && assetPath.startsWith(`${addressStr}/`)) {
    const legacyDirectory = assetPath.slice(addressStr.length + 1);
    directoryIndex = manifest.files[`${legacyDirectory}/index.html`];
  }
  if (!entry && directoryIndex) {
    // Directory hit without trailing slash: redirect so relative URLs resolve.
    return publicSiteRedirect(env, `${path}/`, url.search, addressStr);
  }
  if (!entry) {
    return htmlResponse(NOT_FOUND_PAGE, 404, ARTIFACT_SECURITY_HEADERS);
  }

  const etag = `"${entry.h}"`;
  const protectedSite = site.password_hash !== null;
  const cacheControl = protectedSite
    ? "private, no-store"
    : "public, max-age=60";
  // Never validate a previously cached protected response with 304: doing so
  // would let the browser reuse its stored body after the site was locked.
  if (!protectedSite && req.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, ...publicSiteHeaders(addressStr) },
    });
  }

  const blob = await env.CONTENT.get(`blob/${entry.h}`);
  if (!blob) {
    return htmlResponse(NOT_FOUND_PAGE, 404, ARTIFACT_SECURITY_HEADERS);
  }

  return new Response(blob.body, {
    headers: {
      "content-type": entry.ct,
      "content-length": String(entry.s),
      etag,
      // Public addresses are mutable on re-push. Protected content must never
      // survive the password check in a browser or intermediary cache.
      "cache-control": cacheControl,
      ...(protectedSite ? {} : { "cache-tag": siteCacheTag(addressStr) }),
      ...ARTIFACT_SECURITY_HEADERS,
    },
  });
}

export async function serve(
  req: Request,
  env: Env,
  url: URL,
  siteAddress?: string,
): Promise<Response> {
  return siteAddress === undefined
    ? await serveControlOrigin(env, url)
    : await serveSiteOrigin(req, env, url, siteAddress);
}
