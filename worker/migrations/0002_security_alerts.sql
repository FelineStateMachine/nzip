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
