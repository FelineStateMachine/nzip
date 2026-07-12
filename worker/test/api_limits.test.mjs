import assert from "node:assert/strict";
import test from "node:test";

import { sha256hex } from "../../shared/hash.ts";
import { MAX_BLOB_BYTES } from "../../shared/limits.ts";
import { api } from "../src/api.ts";

function envForBlob() {
  const puts = [];
  return {
    puts,
    env: {
      CONTENT: {
        put: async (key, bytes) => puts.push([key, bytes]),
      },
    },
  };
}

async function put(request, env, hash = "a".repeat(64)) {
  const url = new URL(`https://n.zip/api/blob/${hash}`);
  return await api(request, env, url, {});
}

test("blob upload requires content-length before reading the body", async () => {
  const { env, puts } = envForBlob();
  const response = await put(
    new Request(`https://n.zip/api/blob/${"a".repeat(64)}`, {
      method: "PUT",
      body: new Uint8Array([1]),
    }),
    env,
  );

  assert.equal(response.status, 411);
  assert.equal(puts.length, 0);
});

test("blob upload rejects an oversized declared body before reading it", async () => {
  const { env, puts } = envForBlob();
  const response = await put(
    new Request(`https://n.zip/api/blob/${"a".repeat(64)}`, {
      method: "PUT",
      headers: { "content-length": String(MAX_BLOB_BYTES + 1) },
      body: new Uint8Array([1]),
    }),
    env,
  );

  assert.equal(response.status, 413);
  assert.equal(puts.length, 0);
});

test("blob upload rejects a body that disagrees with its declared length", async () => {
  const { env, puts } = envForBlob();
  const response = await put(
    new Request(`https://n.zip/api/blob/${"a".repeat(64)}`, {
      method: "PUT",
      headers: { "content-length": "1" },
      body: new Uint8Array([1, 2]),
    }),
    env,
  );

  assert.equal(response.status, 400);
  assert.equal(puts.length, 0);
});

test("blob upload accepts a bounded body with a matching hash", async () => {
  const { env, puts } = envForBlob();
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = await sha256hex(bytes);
  const response = await put(
    new Request(`https://n.zip/api/blob/${hash}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.length) },
      body: bytes,
    }),
    env,
    hash,
  );

  assert.equal(response.status, 200);
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], `blob/${hash}`);
});

test("prepare performs no more than six concurrent R2 HEAD requests", async () => {
  const files = {};
  for (let i = 0; i < 13; i++) {
    files[`file-${i}.txt`] = {
      h: i.toString(16).padStart(64, "0"),
      s: 1,
      ct: "text/plain",
    };
  }
  let active = 0;
  let maximumActive = 0;
  const env = {
    CONTENT: {
      head: async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return null;
      },
    },
  };
  const url = new URL("https://n.zip/api/push/prepare");
  const response = await api(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: { v: 1, files } }),
    }),
    env,
    url,
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(maximumActive, 6);
  assert.equal((await response.json()).missing.length, 13);
});

test("shared validation errors are typed as bad requests", async () => {
  const url = new URL("https://n.zip/api/push/prepare");
  const response = await api(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: { v: 2, files: {} } }),
    }),
    {},
    url,
    {},
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "unsupported manifest version" });
});

test("unexpected storage errors are logged but not exposed", async () => {
  const url = new URL("https://n.zip/api/push/prepare");
  const response = await api(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        manifest: {
          v: 1,
          files: { "index.html": { h: "a".repeat(64), s: 1, ct: "text/html" } },
        },
      }),
    }),
    { CONTENT: { head: async () => Promise.reject(new Error("private storage detail")) } },
    url,
    {},
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal error" });
});
