CREATE TABLE IF NOT EXISTS notification_devices (
  id TEXT PRIMARY KEY,
  pairing_code_hash TEXT UNIQUE,
  claim_hash TEXT UNIQUE,
  name TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'active', 'disabled', 'revoked', 'expired')
  ),
  user_agent_summary TEXT,
  device_class TEXT,
  country TEXT,
  region TEXT,
  asn INTEGER,
  endpoint TEXT,
  endpoint_hash TEXT UNIQUE,
  p256dh TEXT,
  auth TEXT,
  created_at INTEGER NOT NULL,
  pairing_expires_at INTEGER,
  claim_expires_at INTEGER,
  approved_at INTEGER,
  active_at INTEGER,
  last_attached_at INTEGER,
  last_seen_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_devices_status
  ON notification_devices(status);

CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT,
  expected_manifest_hash TEXT,
  tag TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_events_created
  ON notification_events(created_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  sent_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (event_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
  ON notification_deliveries(status, next_attempt_at);
