ALTER TABLE security_notifications ADD COLUMN lease_owner TEXT;
ALTER TABLE security_notifications ADD COLUMN lease_expires_at INTEGER;
