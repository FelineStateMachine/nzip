import assert from "node:assert/strict";
import test from "node:test";

import { chooseAlertAction, signalSeverity } from "../src/security_alerts.ts";

function stats(overrides = {}) {
  return {
    bucket: 0,
    addresses: 0,
    scanners: 0,
    misses: 0,
    liveHits: 0,
    rateLimited: 0,
    topScannerAddresses: 0,
    longestSequence: 0,
    vaultMask: 0,
    countries: [],
    asns: [],
    ...overrides,
  };
}

function incident(overrides = {}) {
  return {
    status: "open",
    severity: 1,
    opened_at: 100,
    last_seen_at: 100,
    last_alerted_at: 100,
    quiet_windows: 0,
    peak_addresses: 20,
    total_addresses: 20,
    total_live_hits: 0,
    total_rate_limited: 0,
    vault_mask: 1,
    ...overrides,
  };
}

test("a scanner trying 20 distinct addresses opens a warning", () => {
  const window = stats({
    addresses: 20,
    scanners: 1,
    misses: 20,
    topScannerAddresses: 20,
  });
  assert.equal(signalSeverity(window), 1);
  assert.equal(chooseAlertAction(null, window, 300), "open");
});

test("rate limiting and suspicious live hits are confirmed signals", () => {
  assert.equal(signalSeverity(stats({ rateLimited: 1 })), 2);
  assert.equal(
    signalSeverity(stats({ liveHits: 1, topScannerAddresses: 8 })),
    2,
  );
});

test("distributed enumeration requires breadth, scanners, and mostly misses", () => {
  assert.equal(
    signalSeverity(stats({ addresses: 128, scanners: 10, misses: 120 })),
    1,
  );
  assert.equal(
    signalSeverity(stats({ addresses: 128, scanners: 9, misses: 128 })),
    0,
  );
  assert.equal(
    signalSeverity(stats({ addresses: 128, scanners: 10, misses: 100 })),
    0,
  );
});

test("active incidents suppress duplicates but summarize hourly", () => {
  const window = stats({
    addresses: 20,
    scanners: 1,
    misses: 20,
    topScannerAddresses: 20,
  });
  assert.equal(chooseAlertAction(incident(), window, 200), null);
  assert.equal(chooseAlertAction(incident(), window, 3700), "summary");
});

test("severity and volume changes bypass duplicate suppression", () => {
  assert.equal(
    chooseAlertAction(incident(), stats({ rateLimited: 1 }), 200),
    "escalate",
  );
  assert.equal(
    chooseAlertAction(
      incident(),
      stats({
        addresses: 40,
        scanners: 1,
        misses: 40,
        topScannerAddresses: 40,
      }),
      200,
    ),
    "escalate",
  );
});

test("a newly targeted vault breaks suppression after 30 minutes", () => {
  const window = stats({
    addresses: 20,
    scanners: 1,
    misses: 20,
    topScannerAddresses: 20,
    vaultMask: 2,
  });
  assert.equal(chooseAlertAction(incident(), window, 1800), null);
  assert.equal(chooseAlertAction(incident(), window, 1900), "escalate");
});

test("an incident resolves on its third quiet window", () => {
  assert.equal(
    chooseAlertAction(incident({ quiet_windows: 1 }), stats(), 600),
    null,
  );
  assert.equal(
    chooseAlertAction(incident({ quiet_windows: 2 }), stats(), 900),
    "resolve",
  );
});
