import assert from "node:assert/strict";
import test from "node:test";

import { hasValidUnlockCookie, makeUnlockCookie } from "../src/password.ts";

function requestWith(cookie) {
  return new Request("https://n.zip/12d8", { headers: { cookie: cookie.split(";", 1)[0] } });
}

const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function legacyCookie(env, address) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`nzip-unlock:${env.NZIP_TOKEN}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${address}.${exp}`),
  );
  return `nzip_a${address}=${exp}.${hex(signature)}`;
}

test("unlock cookies are scoped to the current auth version", async () => {
  const env = { NZIP_TOKEN: "test-owner-token" };
  const cookie = await makeUnlockCookie(env, "12d8", 3);
  const req = requestWith(cookie);

  assert.equal(await hasValidUnlockCookie(req, env, "12d8", 3), true);
  assert.equal(await hasValidUnlockCookie(req, env, "12d8", 4), false);
  assert.equal(await hasValidUnlockCookie(req, env, "ffff", 3), false);
});

test("legacy unlock cookies survive migration until the auth version changes", async () => {
  const env = { NZIP_TOKEN: "test-owner-token" };
  const req = requestWith(await legacyCookie(env, "12d8"));

  assert.equal(await hasValidUnlockCookie(req, env, "12d8", 1), true);
  assert.equal(await hasValidUnlockCookie(req, env, "12d8", 2), false);
});
