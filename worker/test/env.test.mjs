import assert from "node:assert/strict";
import test from "node:test";

import { isControlOrigin, siteAddressFromUrl, siteUrl } from "../src/env.ts";

const env = {
  PUBLIC_BASE: "https://n.zip",
  SITE_DOMAIN: "n.zip",
};

test("control and site hosts are classified without trusting arbitrary wildcard hosts", () => {
  assert.equal(isControlOrigin(env, new URL("https://n.zip/api/status")), true);
  assert.equal(isControlOrigin(env, new URL("http://n.zip/2a3f")), true);
  assert.equal(isControlOrigin(env, new URL("https://2a3f.n.zip/")), false);

  assert.equal(siteAddressFromUrl(env, new URL("https://2a3f.n.zip/")), "2a3f");
  assert.equal(siteAddressFromUrl(env, new URL("http://2a3f.n.zip/")), "2a3f");
  assert.equal(siteAddressFromUrl(env, new URL("https://site.n.zip/")), null);
  assert.equal(siteAddressFromUrl(env, new URL("https://2a3f.evil.n.zip/")), null);
  assert.equal(siteAddressFromUrl(env, new URL("https://n.zip/")), null);
});

test("site URLs always derive from the configured public HTTPS base", () => {
  assert.equal(
    siteUrl(env, "2a3f", "/docs/", "?view=full"),
    "https://2a3f.n.zip/docs/?view=full",
  );
});

test("invalid site domains fail closed", () => {
  assert.throws(
    () => siteUrl({ ...env, SITE_DOMAIN: "bad..domain" }, "2a3f"),
    /invalid SITE_DOMAIN/,
  );
});
