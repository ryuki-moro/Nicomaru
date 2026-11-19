-- リスク可視化 (6-8)。Supabase 版 risk_rules / risk_score_snapshots の D1 版。
-- 算出は src/lib/services/risk.ts の純関数をそのまま使い、ここは保存だけを受け持つ。
CREATE TABLE risk_rules (
  id TEXT PRIMARY KEY,
  venue_id TEXT REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  condition_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('low','caution','high')),
  score_delta INTEGER NOT NULL DEFAULT 0 CHECK (score_delta BETWEEN 0 AND 100),
  priority INTEGER NOT NULL DEFAULT 0,
  params TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX risk_rules_venue_key_uk
  ON risk_rules (COALESCE(venue_id, '00000000-0000-0000-0000-000000000000'), condition_key);
CREATE TABLE risk_score_snapshots (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  risk_rule_id TEXT REFERENCES risk_rules(id) ON DELETE SET NULL,
  score_value INTEGER NOT NULL CHECK (score_value BETWEEN 0 AND 100),
  score_level TEXT NOT NULL CHECK (score_level IN ('low','caution','high')),
  reasons TEXT NOT NULL DEFAULT '[]',
  is_current INTEGER NOT NULL DEFAULT 1,
  calculated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX risk_score_snapshots_current_uk
  ON risk_score_snapshots (case_id) WHERE is_current = 1;
CREATE INDEX risk_score_snapshots_case ON risk_score_snapshots(case_id);
-- システム共通ルール (supabase/seed.sql の表6-8 実値と一致させる)。
INSERT OR IGNORE INTO risk_rules (id, venue_id, name, condition_key, level, score_delta, priority, params, description) VALUES
  ('20000000-0000-4000-8000-000000000001', NULL, '挙式30日以内で重要宿題が未提出', 'important_task_overdue', 'high', 30, 40, '{"within_days":30}', '挙式日が近く、重要な宿題が未提出です'),
  ('20000000-0000-4000-8000-000000000002', NULL, '期限超過の未提出宿題がある', 'task_overdue', 'high', 40, 30, '{}', '提出期限を過ぎた宿題があります'),
  ('20000000-0000-4000-8000-000000000003', NULL, '7日以上やり取りが無く未完了あり', 'no_activity_days', 'caution', 20, 20, '{"no_activity_days":7}', '最後のやり取りから日数が経っています'),
  ('20000000-0000-4000-8000-000000000004', NULL, '不備ありの宿題がある', 'needs_fix_exists', 'caution', 15, 10, '{}', '再提出をお願いしている宿題があります');
