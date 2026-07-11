import assert from "node:assert/strict";
import test from "node:test";

import { serve } from "../src/serve.ts";

const HASH = "a".repeat(64);

function envFor(files) {
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
