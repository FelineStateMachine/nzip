-- Existing vaults retain their current behavior. Passwords are stored only as verifiers.
ALTER TABLE vaults ADD COLUMN max_ttl REAL
  CHECK (max_ttl IS NULL OR (max_ttl > 0 AND max_ttl <= 3650));
ALTER TABLE vaults ADD COLUMN require_password INTEGER NOT NULL DEFAULT 0
  CHECK (require_password IN (0, 1));
ALTER TABLE vaults ADD COLUMN default_password_hash TEXT;

-- These guards also cover concurrent API operations and non-CLI writers.
CREATE TRIGGER IF NOT EXISTS sites_vault_policy_insert
BEFORE INSERT ON sites BEGIN
  SELECT CASE WHEN (SELECT require_password FROM vaults WHERE slot = NEW.vault_slot) = 1
    AND NEW.password_hash IS NULL THEN RAISE(ABORT, 'vault requires password protection') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM vaults WHERE slot = NEW.vault_slot AND max_ttl IS NOT NULL
    AND (NEW.expires_at IS NULL OR NEW.expires_at > unixepoch() + round(max_ttl * 86400)))
    THEN RAISE(ABORT, 'site expiry exceeds vault maximum TTL') END;
END;

CREATE TRIGGER IF NOT EXISTS sites_vault_policy_update
BEFORE UPDATE ON sites BEGIN
  SELECT CASE WHEN (SELECT require_password FROM vaults WHERE slot = NEW.vault_slot) = 1
    AND NEW.password_hash IS NULL THEN RAISE(ABORT, 'vault requires password protection') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM vaults WHERE slot = NEW.vault_slot AND max_ttl IS NOT NULL
    AND (NEW.expires_at IS NULL OR NEW.expires_at > unixepoch() + round(max_ttl * 86400)))
    THEN RAISE(ABORT, 'site expiry exceeds vault maximum TTL') END;
END;

CREATE TRIGGER IF NOT EXISTS vault_policy_insert
BEFORE INSERT ON vaults BEGIN
  SELECT CASE WHEN NEW.max_ttl IS NOT NULL AND
    (COALESCE(NEW.default_ttl, 14) = 0 OR COALESCE(NEW.default_ttl, 14) > NEW.max_ttl)
    THEN RAISE(ABORT, 'vault default TTL exceeds maximum TTL') END;
END;

CREATE TRIGGER IF NOT EXISTS vault_policy_update
BEFORE UPDATE ON vaults BEGIN
  SELECT CASE WHEN NEW.max_ttl IS NOT NULL AND
    (COALESCE(NEW.default_ttl, 14) = 0 OR COALESCE(NEW.default_ttl, 14) > NEW.max_ttl)
    THEN RAISE(ABORT, 'vault default TTL exceeds maximum TTL') END;
  SELECT CASE WHEN NEW.require_password = 1 AND EXISTS
    (SELECT 1 FROM sites WHERE vault_slot = OLD.slot AND password_hash IS NULL)
    THEN RAISE(ABORT, 'protect existing sites before requiring vault passwords') END;
  SELECT CASE WHEN NEW.max_ttl IS NOT NULL AND EXISTS
    (SELECT 1 FROM sites WHERE vault_slot = OLD.slot AND
      (expires_at IS NULL OR expires_at > unixepoch() + round(NEW.max_ttl * 86400)))
    THEN RAISE(ABORT, 'shorten existing site expiry before tightening vault maximum TTL') END;
END;
