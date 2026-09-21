-- Existing vaults retain their current behavior. Passwords are stored only as verifiers.
ALTER TABLE vaults ADD COLUMN max_ttl REAL
  CHECK (max_ttl IS NULL OR (max_ttl > 0 AND max_ttl <= 3650));
ALTER TABLE vaults ADD COLUMN require_password INTEGER NOT NULL DEFAULT 0
  CHECK (require_password IN (0, 1));
ALTER TABLE vaults ADD COLUMN default_password_hash TEXT;

-- These guards also cover concurrent API operations and non-CLI writers.
-- Bodies use SELECT RAISE(...) WHERE ... rather than CASE ... END: D1's remote statement splitter
-- ends a trigger at the first END it sees, so a CASE expression inside a body breaks
-- `wrangler d1 migrations apply --remote` with "incomplete input". Keep BEGIN uppercase and LF endings.
CREATE TRIGGER IF NOT EXISTS sites_vault_policy_insert
BEFORE INSERT ON sites BEGIN
  SELECT RAISE(ABORT, 'vault requires password protection')
    WHERE (SELECT require_password FROM vaults WHERE slot = NEW.vault_slot) = 1
      AND NEW.password_hash IS NULL;
  SELECT RAISE(ABORT, 'site expiry exceeds vault maximum TTL')
    WHERE EXISTS (SELECT 1 FROM vaults WHERE slot = NEW.vault_slot AND max_ttl IS NOT NULL
      AND (NEW.expires_at IS NULL OR NEW.expires_at > unixepoch() + round(max_ttl * 86400)));
END;

CREATE TRIGGER IF NOT EXISTS sites_vault_policy_update
BEFORE UPDATE ON sites BEGIN
  SELECT RAISE(ABORT, 'vault requires password protection')
    WHERE (SELECT require_password FROM vaults WHERE slot = NEW.vault_slot) = 1
      AND NEW.password_hash IS NULL;
  SELECT RAISE(ABORT, 'site expiry exceeds vault maximum TTL')
    WHERE EXISTS (SELECT 1 FROM vaults WHERE slot = NEW.vault_slot AND max_ttl IS NOT NULL
      AND (NEW.expires_at IS NULL OR NEW.expires_at > unixepoch() + round(max_ttl * 86400)));
END;

CREATE TRIGGER IF NOT EXISTS vault_policy_insert
BEFORE INSERT ON vaults BEGIN
  SELECT RAISE(ABORT, 'vault default TTL exceeds maximum TTL')
    WHERE NEW.max_ttl IS NOT NULL
      AND (COALESCE(NEW.default_ttl, 14) = 0 OR COALESCE(NEW.default_ttl, 14) > NEW.max_ttl);
END;

CREATE TRIGGER IF NOT EXISTS vault_policy_update
BEFORE UPDATE ON vaults BEGIN
  SELECT RAISE(ABORT, 'vault default TTL exceeds maximum TTL')
    WHERE NEW.max_ttl IS NOT NULL
      AND (COALESCE(NEW.default_ttl, 14) = 0 OR COALESCE(NEW.default_ttl, 14) > NEW.max_ttl);
  SELECT RAISE(ABORT, 'protect existing sites before requiring vault passwords')
    WHERE NEW.require_password = 1
      AND EXISTS (SELECT 1 FROM sites WHERE vault_slot = OLD.slot AND password_hash IS NULL);
  SELECT RAISE(ABORT, 'shorten existing site expiry before tightening vault maximum TTL')
    WHERE NEW.max_ttl IS NOT NULL
      AND EXISTS (SELECT 1 FROM sites WHERE vault_slot = OLD.slot AND
        (expires_at IS NULL OR expires_at > unixepoch() + round(NEW.max_ttl * 86400)));
END;
