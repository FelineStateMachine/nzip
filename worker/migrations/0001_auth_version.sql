-- Revoke existing unlock cookies whenever a site's password policy changes.
ALTER TABLE sites ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;
