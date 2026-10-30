CREATE TABLE notifications (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wedding_cases(id),
  recipient_user_id TEXT NOT NULL REFERENCES user_profiles(id),
  channel TEXT NOT NULL, notification_type TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, link_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending', sent_at TEXT, read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_recipient ON notifications(recipient_user_id, created_at DESC, id DESC);
