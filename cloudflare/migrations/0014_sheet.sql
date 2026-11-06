-- 準備シート（基本設計 4-5／D03）。Supabase版 meeting_sheets をD1へ移す。
-- summary_json は生成時点の集約内容のスナップショット（表5-21）。本文はJSON文字列で持つ。
CREATE TABLE meeting_sheets (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id),
  generated_by TEXT NOT NULL REFERENCES user_profiles(id),
  target_meeting_date TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  ai_draft_job_id TEXT REFERENCES ai_jobs(id),
  pdf_file_id TEXT REFERENCES storage_files(id),
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX meeting_sheets_case ON meeting_sheets(case_id, generated_at);
