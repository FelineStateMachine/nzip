-- nzip D1 schema. Idempotent; apply with:
--   wrangler d1 execute nzip --remote --file schema.sql

CREATE TABLE IF NOT EXISTS vaults (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 0 AND 15),
  name TEXT NOT NULL UNIQUE,
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
  password_hash TEXT,              -- reserved for password shares; NULL = public
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
