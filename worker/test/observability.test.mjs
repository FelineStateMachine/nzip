import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSecurityRequestEvent,
  recordEnumerationProbe,
} from "../src/observability.ts";

function eventFor(path, status, method = "GET") {
  const url = new URL(path, "https://n.zip");
  return buildSecurityRequestEvent(
    new Request(url, { method }),
    url,
    new Response(null, { status }),
  );
}

function siteEventFor(path, status, method = "GET") {
  const url = new URL(path, "https://0123.n.zip");
  return buildSecurityRequestEvent(
    new Request(url, { method }),
    url,
    new Response(null, { status }),
    "0123",
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

test("site-origin probes retain the hostname address", () => {
  assert.equal(siteEventFor("/", 404)?.path_class, "address");
  assert.equal(siteEventFor("/__unlock", 429, "POST")?.path_class, "unlock");
  assert.equal(siteEventFor("/missing.js", 404)?.address, "0123");
  assert.equal(siteEventFor("/app.js", 200), null);
});

class FakeRateLimit {
  calls = [];

  constructor(allow) {
    this.allow = allow;
  }

  async limit(options) {
    this.calls.push(options);
    return { success: this.allow(this.calls.length) };
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    this.db.writes.push({ sql: this.sql, params: this.params });
    return { success: true };
  }
}

class FakeD1 {
  writes = [];

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

function recordingEnv({ observe = () => true, signal = () => true } = {}) {
  const DB = new FakeD1();
  const RL_OBSERVE = new FakeRateLimit(observe);
  const RL_SIGNAL = new FakeRateLimit(signal);
  return {
    DB,
    RL_OBSERVE,
    RL_SIGNAL,
    NZIP_TOKEN: "test-scanner-digest-secret",
  };
}

function record(path, status, env, ip = "192.0.2.10") {
  const url = new URL(path, "https://n.zip");
  return recordEnumerationProbe(
    new Request(url, { headers: { "cf-connecting-ip": ip } }),
    env,
    url,
    new Response(null, { status }),
  );
}

test("ordinary probes use the observation persistence quota", async () => {
  const env = recordingEnv();

  await record("/0123", 404, env);

  assert.equal(env.RL_OBSERVE.calls.length, 1);
  assert.equal(env.RL_SIGNAL.calls.length, 0);
  assert.equal(env.DB.writes.length, 1);
  assert.match(env.DB.writes[0].sql, /security_probes/);
});

test("denied observation quota performs no D1 writes", async () => {
  const env = recordingEnv({ observe: () => false });

  await record("/0123", 404, env);

  assert.equal(env.RL_OBSERVE.calls.length, 1);
  assert.equal(env.RL_SIGNAL.calls.length, 0);
  assert.equal(env.DB.writes.length, 0);
});

test("429 confirmations use the signal quota instead of bypassing persistence limits", async () => {
  const env = recordingEnv();

  await record("/0123", 429, env);

  assert.equal(env.RL_OBSERVE.calls.length, 0);
  assert.equal(env.RL_SIGNAL.calls.length, 1);
  assert.equal(env.DB.writes.length, 2);
  assert.match(env.DB.writes[0].sql, /security_probes/);
  assert.match(env.DB.writes[1].sql, /security_signals/);
  assert.match(env.DB.writes[1].sql, /'rate_limited'/);
  assert.equal(env.RL_SIGNAL.calls[0].key.length, 16);
});

test("denied signal quota performs no D1 writes for 429 responses", async () => {
  const env = recordingEnv({ signal: () => false });

  await record("/0123", 429, env);

  assert.equal(env.RL_OBSERVE.calls.length, 0);
  assert.equal(env.RL_SIGNAL.calls.length, 1);
  assert.equal(env.DB.writes.length, 0);
});

test("a flood of 429 responses is bounded to one permitted persistence pair", async () => {
  const env = recordingEnv({ signal: (callNumber) => callNumber === 1 });

  await Promise.all(
    Array.from({ length: 250 }, () => record("/0123", 429, env)),
  );

  assert.equal(env.RL_OBSERVE.calls.length, 0);
  assert.equal(env.RL_SIGNAL.calls.length, 250);
  assert.equal(env.DB.writes.length, 2);
  assert.equal(
    env.DB.writes.filter(({ sql }) => sql.includes("security_probes")).length,
    1,
  );
  assert.equal(
    env.DB.writes.filter(({ sql }) => sql.includes("security_signals")).length,
    1,
  );
  assert.equal(new Set(env.RL_SIGNAL.calls.map(({ key }) => key)).size, 1);
});
