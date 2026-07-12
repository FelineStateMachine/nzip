import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseAlertAction,
  drainSecurityNotifications,
  evaluateEnumerationWindow,
  sendDailySecurityDigest,
  signalSeverity,
} from "../src/security_alerts.ts";

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

class FakeStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new FakeStatement(this.db, this.sql, args);
  }

  async all() {
    if (this.sql.includes("FROM security_probes")) {
      return { results: this.db.probes };
    }
    if (this.sql.includes("FROM security_notifications")) {
      return {
        results: [...this.db.notifications.values()]
          .filter((row) => row.sent_at === null)
          .sort((a, b) => a.created_at - b.created_at),
      };
    }
    throw new Error(`unexpected all(): ${this.sql}`);
  }

  async first() {
    if (
      this.sql.includes("COUNT(*) AS addresses") &&
      this.sql.includes("FROM security_probes")
    ) {
      return {
        addresses: this.db.probes.length,
        scanners: new Set(this.db.probes.map((probe) => probe.scanner_id)).size,
        live_hits: this.db.probes.reduce(
          (sum, probe) => sum + probe.is_live,
          0,
        ),
      };
    }
    if (this.sql.includes("FROM security_signals")) {
      return { count: this.db.rateLimited };
    }
    if (this.sql.includes("FROM security_incidents")) {
      return this.db.incident;
    }
    throw new Error(`unexpected first(): ${this.sql}`);
  }

  async run() {
    if (this.sql.includes("INSERT INTO security_incidents")) {
      const [
        status,
        severity,
        opened_at,
        last_seen_at,
        last_alerted_at,
        quiet_windows,
        peak_addresses,
        total_addresses,
        total_live_hits,
        total_rate_limited,
        vault_mask,
      ] = this.args;
      this.db.incident = {
        status,
        severity,
        opened_at,
        last_seen_at,
        last_alerted_at,
        quiet_windows,
        peak_addresses,
        total_addresses,
        total_live_hits,
        total_rate_limited,
        vault_mask,
      };
      return { success: true };
    }
    if (
      this.sql.includes("INSERT OR IGNORE INTO security_notifications") &&
      this.sql.includes("'daily-digest'")
    ) {
      const [id, window_bucket, subject, text, created_at] = this.args;
      if (!this.db.notifications.has(id)) {
        this.db.notifications.set(id, {
          id,
          incident_name: "security",
          action: "daily-digest",
          window_bucket,
          subject,
          text,
          html: null,
          created_at,
          sent_at: null,
          attempts: 0,
          last_error: null,
        });
      }
      return { success: true };
    }
    if (this.sql.includes("INSERT OR IGNORE INTO security_notifications")) {
      const [
        id,
        incident_name,
        action,
        window_bucket,
        subject,
        text,
        html,
        created_at,
      ] = this.args;
      if (!this.db.notifications.has(id)) {
        this.db.notifications.set(id, {
          id,
          incident_name,
          action,
          window_bucket,
          subject,
          text,
          html,
          created_at,
          sent_at: null,
          attempts: 0,
          last_error: null,
        });
      }
      return { success: true };
    }
    if (this.sql.includes("SET sent_at = ?")) {
      const [sentAt, id] = this.args;
      const row = this.db.notifications.get(id);
      if (row?.sent_at === null) {
        row.sent_at = sentAt;
        row.attempts += 1;
        row.last_error = null;
      }
      return { success: true };
    }
    if (this.sql.includes("SET attempts = attempts + 1")) {
      const [lastError, id] = this.args;
      const row = this.db.notifications.get(id);
      if (row?.sent_at === null) {
        row.attempts += 1;
        row.last_error = lastError;
      }
      return { success: true };
    }
    throw new Error(`unexpected run(): ${this.sql}`);
  }
}

class FakeDb {
  probes = [];
  rateLimited = 0;
  incident = null;
  notifications = new Map();
  batches = 0;

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    this.batches += 1;
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

test("a transient email failure preserves and retries the original alert", async () => {
  const db = new FakeDb();
  db.probes = Array.from({ length: 20 }, (_, address) => ({
    scanner_id: "scanner-a",
    address,
    is_live: 0,
    vault_slot: 0,
    country: "US",
    asn: 64500,
  }));
  const deliveries = [];
  let failNext = true;
  const env = {
    DB: db,
    ALERT_EMAIL_FROM: "security@example.com",
    ALERT_EMAIL_TO: "operator@example.com",
    EMAIL: {
      async send(message) {
        // Both durable records must exist before delivery is attempted.
        assert.equal(db.incident?.status, "open");
        assert.equal(db.notifications.size, 1);
        deliveries.push(message);
        if (failNext) {
          failNext = false;
          throw new Error("temporary email outage");
        }
      },
    },
  };

  await evaluateEnumerationWindow(env, 600);

  const [notification] = db.notifications.values();
  assert.equal(db.batches, 1);
  assert.equal(notification.id, "enumeration:open:300");
  assert.equal(notification.sent_at, null);
  assert.equal(notification.attempts, 1);
  assert.equal(notification.last_error, "temporary email outage");
  assert.equal(db.incident.last_alerted_at, 600);

  // A later cron drain retries the exact stored payload, not a new window.
  await drainSecurityNotifications(env, 900);

  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[1], deliveries[0]);
  assert.match(deliveries[1].text, /Notification ID: enumeration:open:300/);
  assert.equal(notification.sent_at, 900);
  assert.equal(notification.attempts, 2);
  assert.equal(notification.last_error, null);
});

test("the daily digest is durably deduplicated by UTC day", async () => {
  const db = new FakeDb();
  db.probes = [{
    scanner_id: "scanner-a",
    address: 1,
    is_live: 0,
    vault_slot: 0,
    country: null,
    asn: null,
  }];
  let sends = 0;
  const env = {
    DB: db,
    ALERT_EMAIL_FROM: "security@example.com",
    ALERT_EMAIL_TO: "operator@example.com",
    EMAIL: {
      async send() {
        sends += 1;
        if (sends === 1) throw new Error("temporary email outage");
      },
    },
  };
  const now = 2 * 86400 + 123;

  await sendDailySecurityDigest(env, now);
  await sendDailySecurityDigest(env, now + 60);

  assert.equal(db.notifications.size, 1);
  const [notification] = db.notifications.values();
  assert.equal(notification.id, `security:daily-digest:${2 * 86400}`);
  assert.match(
    notification.text,
    new RegExp(`Notification ID: ${notification.id}`),
  );
  assert.equal(notification.sent_at, now + 60);
  assert.equal(notification.attempts, 2);
});
