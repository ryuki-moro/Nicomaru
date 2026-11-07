-- 通知の残り (6-9): 送信ログ・式場別設定・送信上限カウンタ。Supabase 版
-- notification_logs (phase2_tables) / notification_settings・quota (notification_functions) の D1 版。
-- D1 の notifications 本体は 0005 で作成済み。venue は wedding_cases 経由で辿る。
CREATE TABLE notification_logs (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('line','email')),
  provider_message_id TEXT,
  response_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('success','failure')),
  attempt_no INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX notification_logs_notif ON notification_logs(notification_id);
CREATE INDEX notification_logs_export_order ON notification_logs(created_at DESC, id DESC);
CREATE TABLE notification_settings (
  id TEXT PRIMARY KEY,
  venue_id TEXT REFERENCES venues(id) ON DELETE CASCADE,
  line_per_case_per_week INTEGER NOT NULL DEFAULT 1 CHECK (line_per_case_per_week >= 0),
  line_per_venue_per_month INTEGER NOT NULL DEFAULT 180 CHECK (line_per_venue_per_month >= 0),
  due_reminder_days_before INTEGER NOT NULL DEFAULT 7 CHECK (due_reminder_days_before >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX notification_settings_venue_uk
  ON notification_settings (COALESCE(venue_id, '00000000-0000-0000-0000-000000000000'));
INSERT OR IGNORE INTO notification_settings (id, venue_id) VALUES ('notification-settings-default', NULL);
CREATE TABLE notification_quota_counters (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('case_week','venue_month')),
  scope_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scope, scope_id, window_start)
);
CREATE INDEX notification_quota_window ON notification_quota_counters(scope, window_start);
