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
