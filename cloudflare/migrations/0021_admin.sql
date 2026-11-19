-- 管理系 CRUD の不足列と、テンプレートの正規化テーブル (T01〜T03 / S01・S02)。
-- venues.code は 0003 で追加済み。ここでは連絡先・状態・日時を足す。
-- 行のあるテーブルへの ADD COLUMN は CURRENT_TIMESTAMP を既定にできない（SQLite の制約。
-- 空のテーブルでは通るため本番だけ失敗する）。固定値で足してから既存行を現在時刻で埋め、
-- 以降の INSERT は日時を明示する。
ALTER TABLE venues ADD COLUMN contact_email TEXT;
ALTER TABLE venues ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE venues ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00';
ALTER TABLE venues ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00';
UPDATE venues SET created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;

-- plan_types は templates_json が割当の実行時ソース。編集用の列を足し、
-- 正規化テーブル (下記) を正として保存時に templates_json を再生成する。
ALTER TABLE plan_types ADD COLUMN description TEXT;
ALTER TABLE plan_types ADD COLUMN default_guest_count_min INTEGER;
ALTER TABLE plan_types ADD COLUMN default_guest_count_max INTEGER;
ALTER TABLE plan_types ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_types ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00';
UPDATE plan_types SET updated_at = CURRENT_TIMESTAMP;

CREATE TABLE task_templates (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  description TEXT,
  submission_format TEXT NOT NULL DEFAULT 'text',
  allowed_file_types TEXT NOT NULL DEFAULT '[]',
  default_options TEXT NOT NULL DEFAULT '{}',
  due_offset_days INTEGER NOT NULL DEFAULT 0,
  importance TEXT NOT NULL DEFAULT 'normal',
  is_required INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (venue_id, name)
);
CREATE INDEX task_templates_venue ON task_templates(venue_id, active DESC, due_offset_days DESC, name);

CREATE TABLE plan_task_templates (
  plan_type_id TEXT NOT NULL REFERENCES plan_types(id) ON DELETE CASCADE,
  task_template_id TEXT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  due_offset_days_override INTEGER,
  is_required INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (plan_type_id, task_template_id)
);
CREATE INDEX plan_task_templates_plan ON plan_task_templates(plan_type_id, display_order);
