CREATE TABLE IF NOT EXISTS notification_pairing_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled_until INTEGER NOT NULL
);
