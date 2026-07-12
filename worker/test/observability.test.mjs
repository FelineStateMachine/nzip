import assert from "node:assert/strict";
import test from "node:test";

import { buildSecurityRequestEvent } from "../src/observability.ts";

function eventFor(path, status, method = "GET") {
  const url = new URL(path, "https://n.zip");
  return buildSecurityRequestEvent(
    new Request(url, { method }),
    url,
    new Response(null, { status }),
  );
}

test("four-hex address probes include derived vault and site locations", () => {
  assert.deepEqual(eventFor("/0123", 404), {
    event: "security.request",
    sample_rate: 0.01,
    path_class: "address",
    path: "/0123",
    method: "GET",
    status: 404,
    result: "not_found",
    address: "0123",
    vault_slot: 0,
    site_slot: 0x123,
  });
});

test("scanner-shaped invalid paths are classified without an address", () => {
  assert.deepEqual(eventFor("/.env", 404), {
    event: "security.request",
    sample_rate: 0.01,
    path_class: "invalid",
    path: "/.env",
    method: "GET",
    status: 404,
    result: "not_found",
  });
});

test("successful assets and service paths do not produce security events", () => {
  assert.equal(eventFor("/0123/app.js", 200), null);
  assert.equal(eventFor("/", 200), null);
  assert.equal(eventFor("/favicon.ico", 200), null);
});

test("missing assets and unlock attempts retain their request class", () => {
  assert.equal(eventFor("/0123/missing.js", 404)?.path_class, "address_asset");
  assert.equal(eventFor("/0123/__unlock", 429, "POST")?.path_class, "unlock");
  assert.equal(eventFor("/0123/__unlock", 429, "POST")?.result, "rate_limited");
});
