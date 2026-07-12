-- nzip D1 schema. Idempotent; apply with:
--   wrangler d1 execute nzip --remote --file schema.sql

CREATE TABLE IF NOT EXISTS vaults (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 0 AND 15),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  address INTEGER PRIMARY KEY CHECK (address BETWEEN 0 AND 65535),
  vault_slot INTEGER NOT NULL REFERENCES vaults(slot),
  alias TEXT,
  current_manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,              -- unix seconds; NULL = permanent
  password_hash TEXT,              -- PBKDF2 password verifier; NULL = public
  auth_version INTEGER NOT NULL DEFAULT 1, -- increment to revoke unlock cookies
  UNIQUE (vault_slot, alias)
);
CREATE INDEX IF NOT EXISTS idx_sites_expiry ON sites(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pushes (
  address INTEGER NOT NULL REFERENCES sites(address) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  pushed_at INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (address, seq)
);

CREATE TABLE IF NOT EXISTS security_probes (
  bucket INTEGER NOT NULL,
  scanner_id TEXT NOT NULL,
  address INTEGER NOT NULL CHECK (address BETWEEN 0 AND 65535),
  vault_slot INTEGER NOT NULL CHECK (vault_slot BETWEEN 0 AND 15),
  is_live INTEGER NOT NULL CHECK (is_live IN (0, 1)),
  country TEXT,
  asn INTEGER,
  PRIMARY KEY (bucket, scanner_id, address)
);

CREATE TABLE IF NOT EXISTS security_signals (
  bucket INTEGER NOT NULL,
  scanner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (bucket, scanner_id, kind)
);

CREATE TABLE IF NOT EXISTS security_incidents (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  severity INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_alerted_at INTEGER NOT NULL,
  quiet_windows INTEGER NOT NULL,
  peak_addresses INTEGER NOT NULL,
  total_addresses INTEGER NOT NULL,
  total_live_hits INTEGER NOT NULL,
  total_rate_limited INTEGER NOT NULL,
  vault_mask INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS security_notifications (
  id TEXT PRIMARY KEY,
  incident_name TEXT NOT NULL,
  action TEXT NOT NULL,
  window_bucket INTEGER NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  html TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_notifications_pending
  ON security_notifications(created_at)
  WHERE sent_at IS NULL;
