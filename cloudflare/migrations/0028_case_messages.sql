-- 案件ごとのチャット。本文は暗号化して持ち、取り消し時は本文を消して deleted_at だけ残す。
-- created_at / last_read_at はアプリが入れる ISO 8601 (UTC・ミリ秒) の文字列で、(created_at,id) の昇順が表示順。
CREATE TABLE case_messages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES user_profiles(id),
  body_enc TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_case_messages_case ON case_messages(case_id, created_at, id);
CREATE TABLE case_message_reads (
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user_profiles(id),
  last_read_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (case_id, user_id)
);
