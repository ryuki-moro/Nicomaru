ALTER TABLE user_profiles ADD COLUMN phone TEXT;
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT, detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_logs_target ON audit_logs(target_type,target_id,created_at);
