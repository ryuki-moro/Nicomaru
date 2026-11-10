-- 容量・利用状況の日次スナップショットと、管理者共通のアラート (GAP-03/04)。
-- Supabase 版 usage_snapshots (20261009000100) / system_alerts (20261009000200) の D1 版。
-- database_bytes は D1 に pg_database_size 相当が無いため、集計側が SQLite の
-- ページ数から算出した概算を入れる (請求額の見積もりではない、という位置づけは同じ)。
CREATE TABLE usage_snapshots (
  measured_on TEXT PRIMARY KEY,
  measured_at TEXT NOT NULL,
  database_bytes INTEGER NOT NULL CHECK (database_bytes >= 0),
  storage_bytes INTEGER CHECK (storage_bytes >= 0),
  database_limit_bytes INTEGER CHECK (database_limit_bytes > 0),
  storage_limit_bytes INTEGER CHECK (storage_limit_bytes > 0),
  venue_count INTEGER NOT NULL DEFAULT 0,
  case_count INTEGER NOT NULL DEFAULT 0,
  user_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  notification_count INTEGER NOT NULL DEFAULT 0,
  notification_failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE system_alerts (
  alert_key TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('batch','health','ai','notification','capacity','auth')),
  source TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  affected_count INTEGER NOT NULL DEFAULT 0,
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX system_alerts_open ON system_alerts(resolved_at, last_detected_at DESC);
