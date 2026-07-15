import assert from "node:assert/strict";
import test from "node:test";

import { serve } from "../src/serve.ts";
import { hashPassword } from "../src/password.ts";

const HASH = "a".repeat(64);

function envFor(files, siteOverrides = {}) {
  const manifest = new TextEncoder().encode(JSON.stringify({ v: 1, files }));
  const site = {
    address: 0x2f9b,
    vault_slot: 2,
    alias: null,
    current_manifest: "manifest-hash",
    created_at: 0,
    updated_at: 0,
    expires_at: null,
    password_hash: null,
    auth_version: 1,
    ...siteOverrides,
  };

  return {
    PUBLIC_BASE: "https://n.zip",
    SITE_DOMAIN: "n.zip",
    DB: {
      prepare() {
        return {
          bind() {
            return { first: async () => site };
          },
        };
      },
    },
    CONTENT: {
      get: async (key) => {
        if (key === "manifest/manifest-hash") {
          return { arrayBuffer: async () => manifest.buffer };
        }
        if (key === `blob/${HASH}`) return { body: new Uint8Array() };
        return null;
      },
    },
  };
}

const html = { h: HASH, s: 0, ct: "text/html; charset=utf-8" };
const css = { h: HASH, s: 0, ct: "text/css; charset=utf-8" };

function serveSite(request, env, url) {
  return serve(request, env, url, "2f9b");
}

test("legacy address paths permanently redirect to the isolated site origin", async () => {
  const response = await serve(
    new Request("https://n.zip/2f9b/index.html?view=full"),
    envFor({ "index.html": html }),
    new URL("https://n.zip/2f9b/index.html?view=full"),
  );

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.equal(response.headers.get("cache-tag"), "nzip-site-2f9b");
  assert.equal(
    response.headers.get("location"),
    "https://2f9b.n.zip/index.html?view=full",
  );
});

test("root index redirects to the isolated site root", async () => {
  const url = new URL("https://2f9b.n.zip/index.html");
  const response = await serveSite(
    new Request(url),
    envFor({ "index.html": html, "style.css": css }),
    url,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://2f9b.n.zip/");
});

test("nested index redirects to its directory", async () => {
  const url = new URL("https://2f9b.n.zip/docs/index.html");
  const response = await serveSite(
    new Request(url),
    envFor({ "index.html": html, "docs/index.html": html }),
    url,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://2f9b.n.zip/docs/");
});

test("canonical redirects use the HTTPS public base instead of the request origin", async (t) => {
  const cases = [
    {
      name: "explicit index",
      requestUrl: "http://internal/index.html?mode=pwa",
      files: { "index.html": html, "style.css": css },
      location: "https://2f9b.n.zip/?mode=pwa",
    },
    {
      name: "directory without trailing slash",
      requestUrl: "http://internal/docs?mode=pwa",
      files: { "index.html": html, "docs/index.html": html },
      location: "https://2f9b.n.zip/docs/?mode=pwa",
    },
  ];

  for (const { name, requestUrl, files, location } of cases) {
    await t.test(name, async () => {
      const url = new URL(requestUrl);
      const response = await serveSite(new Request(url), envFor(files), url);

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), location);
    });
  }
});

test("canonical directory URL serves its index without redirecting", async () => {
  const url = new URL("https://2f9b.n.zip/");
  const response = await serveSite(
    new Request(url),
    envFor({ "index.html": html, "style.css": css }),
    url,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.equal(response.headers.get("cache-tag"), "nzip-site-2f9b");
});

test("missing index path still returns not found", async () => {
  const url = new URL("https://2f9b.n.zip/index.html");
  const response = await serveSite(
    new Request(url),
    envFor({ "download.txt": { ...css, ct: "text/plain; charset=utf-8" } }),
    url,
  );

  assert.equal(response.status, 404);
});

test("old address-prefixed asset bases remain usable on the site origin", async () => {
  const assetUrl = new URL("https://2f9b.n.zip/2f9b/style.css");
  const asset = await serveSite(
    new Request(assetUrl),
    envFor({ "index.html": html, "style.css": css }),
    assetUrl,
  );
  const indexUrl = new URL("https://2f9b.n.zip/2f9b/index.html");
  const index = await serveSite(
    new Request(indexUrl),
    envFor({ "index.html": html, "style.css": css }),
    indexUrl,
  );

  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(index.status, 302);
  assert.equal(index.headers.get("location"), "https://2f9b.n.zip/2f9b/");
});

test("favicon serves the wordmark PNG with a cacheable response", async () => {
  const url = new URL("https://n.zip/favicon.ico");
  const response = await serve(new Request(url), envFor({}), url);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
  const bytes = new Uint8Array(await response.arrayBuffer());
  // PNG signature: the embedded icon decoded from base64 intact.
  assert.deepEqual([...bytes.slice(0, 8)], [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  assert.ok(bytes.length > 500);
});

test("unlock requires a declared request size", async () => {
  const url = new URL("https://2f9b.n.zip/__unlock");
  const response = await serveSite(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=test",
    }),
    envFor({ "index.html": html }, { password_hash: "unused" }),
    url,
  );

  assert.equal(response.status, 411);
});

test("unlock page disables mobile zoom", async () => {
  const url = new URL("https://2f9b.n.zip/");
  const response = await serveSite(
    new Request(url),
    envFor({ "index.html": html }, { password_hash: "hash" }),
    url,
  );

  assert.equal(response.status, 401);
  assert.match(await response.text(), /maximum-scale=1, user-scalable=no/);
});

test("unlock returns to the requested nested page", async () => {
  const passwordHash = await hashPassword("test");
  const pageUrl = new URL("https://2f9b.n.zip/docs/guide.html?view=full");
  const locked = await serveSite(
    new Request(pageUrl),
    envFor({ "docs/guide.html": html }, { password_hash: passwordHash }),
    pageUrl,
  );
  const returnTo = /name="return_to" value="([^"]+)"/.exec(
    await locked.text(),
  )?.[1].replaceAll("&amp;", "&");
  assert.equal(returnTo, "/docs/guide.html?view=full");

  const body = new URLSearchParams({ password: "test", return_to: returnTo });
  const unlockUrl = new URL("https://2f9b.n.zip/__unlock");
  const unlocked = await serveSite(
    new Request(unlockUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(
          new TextEncoder().encode(body.toString()).length,
        ),
      },
      body,
    }),
    envFor({ "docs/guide.html": html }, { password_hash: passwordHash }),
    unlockUrl,
  );

  assert.equal(unlocked.status, 303);
  assert.equal(
    unlocked.headers.get("location"),
    "/docs/guide.html?view=full",
  );
  assert.match(
    unlocked.headers.get("set-cookie") ?? "",
    /^__Host-nzip-unlock=/,
  );
  assert.match(unlocked.headers.get("set-cookie") ?? "", /; Path=\//);
  assert.doesNotMatch(unlocked.headers.get("set-cookie") ?? "", /Domain=/i);
});

test("unlock rejects a return target outside the locked site", async () => {
  const passwordHash = await hashPassword("test");
  const body = new URLSearchParams({
    password: "test",
    return_to: "https://example.com/phishing",
  });
  const unlockUrl = new URL("https://2f9b.n.zip/__unlock");
  const response = await serveSite(
    new Request(unlockUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(
          new TextEncoder().encode(body.toString()).length,
        ),
      },
      body,
    }),
    envFor({ "index.html": html }, { password_hash: passwordHash }),
    unlockUrl,
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
});

test("unlock rejects an oversized declared body before password verification", async () => {
  const url = new URL("https://2f9b.n.zip/__unlock");
  const response = await serveSite(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "4097",
      },
      body: "password=test",
    }),
    envFor({ "index.html": html }, { password_hash: "unused" }),
    url,
  );

  assert.equal(response.status, 413);
});

test("unlock rejects passwords above 256 characters before hashing", async () => {
  const url = new URL("https://2f9b.n.zip/__unlock");
  const body = new URLSearchParams({ password: "x".repeat(257) }).toString();
  const response = await serveSite(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(new TextEncoder().encode(body).length),
      },
      body,
    }),
    envFor({ "index.html": html }, { password_hash: "unused" }),
    url,
  );

  assert.equal(response.status, 400);
});
