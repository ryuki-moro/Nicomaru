-- チャットと案件データの連携。case_messages を作り直して、発言者なしのシステムメッセージを持てるようにする。
-- sender_user_id は NULL 可。kind='system' のときだけ event_type を持ち、本文は保存せず event_type と参照から組み立てる。
-- actor_user_id はシステムメッセージを起こした操作者で、バッチ起点なら NULL。
-- 参照 (case_message_refs) は題名を持たない。表示のたびに見る人の権限で引き直す。
CREATE TABLE case_messages_new (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  sender_user_id TEXT REFERENCES user_profiles(id),
  body_enc TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  event_type TEXT CHECK (event_type IS NULL OR event_type IN ('task_submitted','task_approved','task_returned','task_due_soon','task_overdue','seating_submitted','seating_approved','seating_returned','task_created')),
  actor_user_id TEXT REFERENCES user_profiles(id),
  CHECK ((kind='user' AND sender_user_id IS NOT NULL AND event_type IS NULL) OR (kind='system' AND sender_user_id IS NULL AND event_type IS NOT NULL))
);
INSERT INTO case_messages_new(id,case_id,sender_user_id,body_enc,created_at,deleted_at)
  SELECT id,case_id,sender_user_id,body_enc,created_at,deleted_at FROM case_messages;
DROP TABLE case_messages;
ALTER TABLE case_messages_new RENAME TO case_messages;
CREATE INDEX idx_case_messages_case ON case_messages(case_id, created_at, id);
CREATE TABLE case_message_refs (
  message_id TEXT NOT NULL REFERENCES case_messages(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
  ref_type TEXT NOT NULL CHECK (ref_type IN ('task','guest','seating')),
  ref_id TEXT NOT NULL,
  PRIMARY KEY (message_id, position)
);
ALTER TABLE case_tasks ADD COLUMN source_message_id TEXT REFERENCES case_messages(id) ON DELETE SET NULL;
CREATE INDEX idx_case_tasks_source_message ON case_tasks(source_message_id);
