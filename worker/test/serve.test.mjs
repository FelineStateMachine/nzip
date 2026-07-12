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

test("single-file root index redirects to the bare site URL", async () => {
  const response = await serve(
    new Request("https://n.zip/2f9b/index.html?view=full"),
    envFor({ "index.html": html }),
    new URL("https://n.zip/2f9b/index.html?view=full"),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  assert.equal(response.headers.get("cache-tag"), "nzip-site-2f9b");
  assert.equal(
    response.headers.get("location"),
    "https://n.zip/2f9b?view=full",
  );
});

test("multi-file root index redirects to the site directory", async () => {
  const url = new URL("https://n.zip/2f9b/index.html");
  const response = await serve(
    new Request(url),
    envFor({ "index.html": html, "style.css": css }),
    url,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://n.zip/2f9b/");
});

test("nested index redirects to its directory", async () => {
  const url = new URL("https://n.zip/2f9b/docs/index.html");
  const response = await serve(
    new Request(url),
    envFor({ "index.html": html, "docs/index.html": html }),
    url,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://n.zip/2f9b/docs/");
});

test("canonical directory URL serves its index without redirecting", async () => {
  const url = new URL("https://n.zip/2f9b/");
  const response = await serve(
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
  const url = new URL("https://n.zip/2f9b/index.html");
  const response = await serve(
    new Request(url),
    envFor({ "download.txt": { ...css, ct: "text/plain; charset=utf-8" } }),
    url,
  );

  assert.equal(response.status, 404);
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
  const url = new URL("https://n.zip/2f9b/__unlock");
  const response = await serve(
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
  const url = new URL("https://n.zip/2f9b");
  const response = await serve(
    new Request(url),
    envFor({ "index.html": html }, { password_hash: "hash" }),
    url,
  );

  assert.equal(response.status, 401);
  assert.match(await response.text(), /maximum-scale=1, user-scalable=no/);
});

test("unlock returns to the requested nested page", async () => {
  const passwordHash = await hashPassword("test");
  const pageUrl = new URL("https://n.zip/2f9b/docs/guide.html?view=full");
  const locked = await serve(
    new Request(pageUrl),
    envFor({ "docs/guide.html": html }, { password_hash: passwordHash }),
    pageUrl,
  );
  const returnTo = /name="return_to" value="([^"]+)"/.exec(
    await locked.text(),
  )?.[1].replaceAll("&amp;", "&");
  assert.equal(returnTo, "/2f9b/docs/guide.html?view=full");

  const body = new URLSearchParams({ password: "test", return_to: returnTo });
  const unlockUrl = new URL("https://n.zip/2f9b/__unlock");
  const unlocked = await serve(
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
    "/2f9b/docs/guide.html?view=full",
  );
  assert.match(unlocked.headers.get("set-cookie") ?? "", /^nzip_a2f9b=/);
});

test("unlock rejects a return target outside the locked site", async () => {
  const passwordHash = await hashPassword("test");
  const body = new URLSearchParams({
    password: "test",
    return_to: "https://example.com/phishing",
  });
  const unlockUrl = new URL("https://n.zip/2f9b/__unlock");
  const response = await serve(
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
  assert.equal(response.headers.get("location"), "/2f9b");
});

test("unlock rejects an oversized declared body before password verification", async () => {
  const url = new URL("https://n.zip/2f9b/__unlock");
  const response = await serve(
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
  const url = new URL("https://n.zip/2f9b/__unlock");
  const body = new URLSearchParams({ password: "x".repeat(257) }).toString();
  const response = await serve(
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
