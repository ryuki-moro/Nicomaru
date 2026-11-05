ALTER TABLE case_tasks ADD COLUMN description TEXT;
ALTER TABLE case_tasks ADD COLUMN options TEXT;
ALTER TABLE case_tasks ADD COLUMN allowed_file_types TEXT NOT NULL DEFAULT '[]';
ALTER TABLE case_tasks ADD COLUMN is_required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE case_tasks ADD COLUMN confirmed_by TEXT REFERENCES user_profiles(id);
ALTER TABLE case_tasks ADD COLUMN confirmed_at TEXT;
ALTER TABLE case_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE storage_files (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wedding_cases(id),
  task_id TEXT NOT NULL REFERENCES case_tasks(id), uploaded_by TEXT NOT NULL REFERENCES user_profiles(id),
  object_path TEXT NOT NULL UNIQUE, original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL, file_size_bytes INTEGER NOT NULL CHECK(file_size_bytes BETWEEN 1 AND 5242880)
);
CREATE TABLE task_submissions (
  id TEXT PRIMARY KEY, case_task_id TEXT NOT NULL REFERENCES case_tasks(id),
  submitted_by TEXT NOT NULL REFERENCES user_profiles(id), submission_type TEXT NOT NULL CHECK(submission_type IN ('text','select','file','none')),
  text_value TEXT, selected_value TEXT, file_id TEXT REFERENCES storage_files(id), comment TEXT,
  review_status TEXT NOT NULL CHECK(review_status IN ('draft','submitted','needs_fix','confirmed')),
  planner_feedback TEXT, reviewed_by TEXT REFERENCES user_profiles(id), reviewed_at TEXT,
  submitted_at TEXT NOT NULL, is_latest INTEGER NOT NULL CHECK(is_latest IN (0,1))
);
CREATE UNIQUE INDEX task_submissions_latest ON task_submissions(case_task_id) WHERE is_latest=1;
CREATE INDEX task_submissions_pending ON task_submissions(review_status,is_latest,submitted_at);
