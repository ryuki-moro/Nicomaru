-- 打ち合わせ記録（基本設計 D05／9-5）。Supabase版 meeting_notes をD1へ移す。
-- 記録の保存を契機に task_extraction ジョブを ai_jobs（0010_ai）へ投入する。
CREATE TABLE meeting_notes (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id),
  created_by TEXT NOT NULL REFERENCES user_profiles(id),
  meeting_date TEXT,
  participants TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX meeting_notes_case ON meeting_notes(case_id, created_at);
