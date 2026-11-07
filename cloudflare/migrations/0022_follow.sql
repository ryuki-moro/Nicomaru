CREATE TABLE follow_logs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  planner_id TEXT NOT NULL REFERENCES user_profiles(id),
  method TEXT NOT NULL CHECK(method IN ('phone','meeting','email','line','other')),
  note TEXT,
  followed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX follow_logs_case_time ON follow_logs(case_id,followed_at DESC,id DESC);
CREATE TABLE communication_logs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('in_app','line','email','phone','meeting','other')),
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  summary TEXT NOT NULL,
  created_by TEXT REFERENCES user_profiles(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX communication_logs_case_time ON communication_logs(case_id,created_at DESC);
