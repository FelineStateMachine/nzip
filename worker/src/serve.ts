import { parseAddress, parseManifest } from "../../shared/mod.ts";
import { getSiteByAddress, type SiteRow } from "./db.ts";
import type { Env } from "./env.ts";
import { hasValidUnlockCookie, makeUnlockCookie, verifyPassword } from "./password.ts";

const GONE_PAGE = `<!doctype html><meta charset="utf-8"><title>expired — nzip</title>
<style>body{background:#121110;color:#8a8172;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}b{color:#ffb347;font-size:32px;display:block;margin-bottom:8px}</style>
<div><b>410</b>this share expired</div>`;

const NOT_FOUND_PAGE = `<!doctype html><meta charset="utf-8"><title>not found — nzip</title>
<style>body{background:#121110;color:#8a8172;font-family:ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}b{color:#ffb347;font-size:32px;display:block;margin-bottom:8px}</style>
<div><b>404</b>nothing here</div>`;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

// The landing shows the deployment's own hostname, derived from PUBLIC_BASE, so
// the committed source carries no operator-specific branding. It pairs that
// hostname with the nzip wordmark; the coral z is the product's small visual mark.
function landingPage(env: Env): string {
  const host = new URL(env.PUBLIC_BASE).host;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(host)}</title>
<style>body{background:#1e1810;color:#e7dbc5;font-family:ui-monospace,monospace;margin:0;min-height:100dvh;display:flex;flex-direction:column}main{flex:1;display:grid;place-items:center;padding:24px;text-align:center}.landing{display:grid;gap:24px;justify-items:center}.wordmark{color:#f2e8d4;font-size:clamp(40px,10vw,72px);font-weight:700;letter-spacing:-.18em;line-height:.8}.wordmark .z{color:#ff6b4a}.host{font-size:clamp(14px,2vw,18px);letter-spacing:-.06em}.host b{color:#d99a5b}footer{text-align:center;padding:14px 16px calc(14px + env(safe-area-inset-bottom))}a{color:#6b6355;font-size:12px;text-decoration:underline}a:hover{color:#d99a5b}</style>
<main><div class="landing"><div class="wordmark" aria-label="nzip">n<span class="z">z</span>ip</div></div></main><footer><a href="https://args.io/cat/nzip">args</a></footer>`;
}

function htmlResponse(body: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function unlockForm(address: string, error?: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex"><title>unlock — nzip</title>
<style>*{box-sizing:border-box}body{background:#121110;color:#d6cfc2;font-family:ui-monospace,monospace;display:grid;place-items:center;min-height:100vh;min-height:100dvh;margin:0;padding:max(24px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}form{width:min(100%,420px);text-align:center}b{color:#ffb347;font-size:24px;display:block;margin-bottom:20px}.field{display:flex;width:100%}input{background:#1a1815;border:1px solid #2e2a24;color:#d6cfc2;min-width:0;flex:1;padding:12px 14px;font:inherit;font-size:16px;line-height:20px;outline:none;border-radius:0}input:focus{border-color:#ffb347}button{background:#ffb347;border:0;color:#121110;min-height:46px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer;border-radius:0}.e{color:#f7768e;margin-top:12px;font-size:13px}@media(max-width:360px){.field{display:grid;gap:10px}button{width:100%}}</style>
<form method="post" action="/${address}/__unlock"><b>&#128274; ${address}</b><div class="field"><input type="password" name="password" aria-label="password" placeholder="password" autofocus autocomplete="current-password"><button>unlock</button></div>${
    error ? `<div class="e">${error}</div>` : ""
  }</form>`;
}

async function handleUnlock(req: Request, env: Env, site: SiteRow, address: string): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const password = form?.get("password");
  if (typeof password !== "string" || !site.password_hash ||
    !(await verifyPassword(password, site.password_hash))) {
    return htmlResponse(unlockForm(address, "wrong password"), 401);
  }
  return new Response(null, {
    status: 303,
    headers: {
      // Bare address: single-file sites serve there directly, multi-file ones
      // bounce through the trailing-slash redirect.
      location: `/${address}`,
      "set-cookie": await makeUnlockCookie(env, address),
    },
  });
}

export async function serve(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/") return htmlResponse(landingPage(env), 200);
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (path === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /\n", {
      headers: { "content-type": "text/plain" },
    });
  }

  // /{4hex} or /{4hex}/{asset-path}
  const m = path.match(/^\/([0-9a-f]{4})(\/.*)?$/);
  if (!m) return htmlResponse(NOT_FOUND_PAGE, 404);
  const addressStr = m[1];

  const site = await getSiteByAddress(env, parseAddress(addressStr));
  if (!site) return htmlResponse(NOT_FOUND_PAGE, 404);
  const now = Math.floor(Date.now() / 1000);
  if (site.expires_at !== null && site.expires_at < now) return htmlResponse(GONE_PAGE, 410);

  // Password gate.
  if (m[2] === "/__unlock" && req.method === "POST") {
    return await handleUnlock(req, env, site, addressStr);
  }
  if (site.password_hash && !(await hasValidUnlockCookie(req, env, addressStr))) {
    return htmlResponse(unlockForm(addressStr), 401);
  }

  const manifestObj = await env.CONTENT.get(`manifest/${site.current_manifest}`);
  if (!manifestObj) return htmlResponse(NOT_FOUND_PAGE, 404);
  const manifest = parseManifest(new Uint8Array(await manifestObj.arrayBuffer()));
  const filePaths = Object.keys(manifest.files);

  // Bare address: single-file sites serve directly (URL stays /{4hex} — nothing
  // relative to break); multi-file bundles redirect to the trailing slash so
  // relative asset URLs resolve.
  let assetPath: string;
  let explicitIndexPath = false;
  if (m[2] === undefined) {
    if (filePaths.length !== 1) {
      return Response.redirect(new URL(`/${addressStr}/`, url).toString(), 302);
    }
    assetPath = filePaths[0];
  } else {
    assetPath = decodeURIComponent(m[2].slice(1)); // strip leading /
    explicitIndexPath = /(^|\/)index\.html$/.test(assetPath);
    if (assetPath === "" || assetPath.endsWith("/")) assetPath += "index.html";
  }

  // Keep directory index filenames out of public URLs. Static generators often
  // emit same-page and anchor links as `index.html` or `index.html#section`;
  // browsers preserve the fragment while following this redirect.
  if (explicitIndexPath && manifest.files[assetPath]) {
    const isRootIndex = assetPath === "index.html";
    const canonicalPath = isRootIndex && filePaths.length === 1
      ? `/${addressStr}`
      : path.slice(0, -"index.html".length);
    const canonicalUrl = new URL(canonicalPath, url);
    canonicalUrl.search = url.search;
    return Response.redirect(canonicalUrl.toString(), 302);
  }

  let entry = manifest.files[assetPath];
  if (!entry && manifest.files[`${assetPath}/index.html`]) {
    // Directory hit without trailing slash: redirect so relative URLs resolve.
    return Response.redirect(new URL(`${path}/`, url).toString(), 302);
  }
  if (!entry) return htmlResponse(NOT_FOUND_PAGE, 404);

  const etag = `"${entry.h}"`;
  const protectedSite = site.password_hash !== null;
  const cacheControl = protectedSite ? "private, no-store" : "public, max-age=60";
  // Never validate a previously cached protected response with 304: doing so
  // would let the browser reuse its stored body after the site was locked.
  if (!protectedSite && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } });
  }

  const blob = await env.CONTENT.get(`blob/${entry.h}`);
  if (!blob) return htmlResponse(NOT_FOUND_PAGE, 404);

  return new Response(blob.body, {
    headers: {
      "content-type": entry.ct,
      "content-length": String(entry.s),
      etag,
      // Public addresses are mutable on re-push. Protected content must never
      // survive the password check in a browser or intermediary cache.
      "cache-control": cacheControl,
    },
  });
}
