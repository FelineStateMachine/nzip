-- Visitor feedback is opt-in per site and only served behind the site's password gate.
-- Existing sites keep feedback off. Notes cascade away with their site, so an address that
-- is later reallocated never inherits another site's feedback.
ALTER TABLE sites ADD COLUMN feedback INTEGER NOT NULL DEFAULT 0 CHECK (feedback IN (0, 1));
ALTER TABLE sites ADD COLUMN feedback_requested_at INTEGER;
ALTER TABLE sites ADD COLUMN feedback_submitted_at INTEGER;

CREATE TABLE IF NOT EXISTS site_feedback (
  address INTEGER NOT NULL REFERENCES sites(address) ON DELETE CASCADE,
  item TEXT NOT NULL,
  text TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (address, item)
);

-- Defense in depth for concurrent writers. Bodies use SELECT RAISE(...) WHERE ... (no CASE/END)
-- so D1's remote statement splitter keeps each trigger whole. Keep BEGIN uppercase and LF endings.
CREATE TRIGGER IF NOT EXISTS sites_feedback_policy_insert
BEFORE INSERT ON sites BEGIN
  SELECT RAISE(ABORT, 'feedback requires password protection')
    WHERE NEW.feedback = 1 AND NEW.password_hash IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS sites_feedback_policy_update
BEFORE UPDATE ON sites BEGIN
  SELECT RAISE(ABORT, 'feedback requires password protection')
    WHERE NEW.feedback = 1 AND NEW.password_hash IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS site_feedback_item_cap
BEFORE INSERT ON site_feedback BEGIN
  SELECT RAISE(ABORT, 'feedback item limit reached')
    WHERE (SELECT COUNT(*) FROM site_feedback WHERE address = NEW.address) >= 200
      AND NOT EXISTS (SELECT 1 FROM site_feedback WHERE address = NEW.address AND item = NEW.item);
END;
