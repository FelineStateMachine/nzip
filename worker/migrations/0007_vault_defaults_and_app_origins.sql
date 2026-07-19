-- Add lifecycle-aware retention defaults without changing existing site expiry.
ALTER TABLE vaults ADD COLUMN default_ttl INTEGER
  CHECK (default_ttl IS NULL OR default_ttl BETWEEN 0 AND 3650);

-- Enrich the conventional slots only when they already have the conventional
-- names. Occupied/custom slots and existing names elsewhere are left alone.
UPDATE vaults SET default_ttl = 14
WHERE slot = 0 AND name = 'personal';
UPDATE vaults SET default_ttl = 0
WHERE slot = 15 AND name = 'public';

INSERT OR IGNORE INTO vaults (slot, name, description, default_ttl, created_at)
VALUES (0, 'personal', 'Personal and temporary shares', 14, unixepoch());
INSERT OR IGNORE INTO vaults (slot, name, description, default_ttl, created_at)
VALUES (15, 'public', 'Durable public app origins', 0, unixepoch());

CREATE TABLE IF NOT EXISTS vault_defaults (
  lifecycle TEXT PRIMARY KEY CHECK (lifecycle IN ('temporary', 'permanent')),
  vault_slot INTEGER NOT NULL REFERENCES vaults(slot)
);
INSERT OR IGNORE INTO vault_defaults (lifecycle, vault_slot)
SELECT 'temporary', slot FROM vaults WHERE slot = 0 AND name = 'personal';
INSERT OR IGNORE INTO vault_defaults (lifecycle, vault_slot)
SELECT 'permanent', slot FROM vaults WHERE slot = 15 AND name = 'public';

ALTER TABLE sites ADD COLUMN content_security_policy TEXT;

-- This is deliberately separate from sites: deleting or expiring content must
-- not make an app origin reusable by another application.
CREATE TABLE IF NOT EXISTS app_reservations (
  address INTEGER PRIMARY KEY CHECK (address BETWEEN 0 AND 65535),
  vault_slot INTEGER NOT NULL REFERENCES vaults(slot),
  alias TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  UNIQUE (vault_slot, alias)
);
