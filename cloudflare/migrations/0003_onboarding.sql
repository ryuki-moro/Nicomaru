ALTER TABLE venues ADD COLUMN code TEXT;
UPDATE venues SET code='LOCAL' || substr(id,-4) WHERE code IS NULL;
CREATE UNIQUE INDEX venues_code ON venues(code);
CREATE TABLE case_counters (
  venue_id TEXT NOT NULL REFERENCES venues(id), year INTEGER NOT NULL, value INTEGER NOT NULL,
  PRIMARY KEY(venue_id,year)
);
CREATE TABLE case_invitations (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wedding_cases(id),
  target_partner_role TEXT NOT NULL CHECK(target_partner_role IN ('groom','bride')),
  purpose TEXT NOT NULL DEFAULT 'initial_registration', token_hash TEXT NOT NULL UNIQUE,
  recipient_email_hash TEXT, channel TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT, sent_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 1,
  claim_id TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY(case_id,target_partner_role) REFERENCES couple_profiles(case_id,partner_role)
);
CREATE INDEX invitations_case ON case_invitations(case_id,target_partner_role,created_at);
CREATE UNIQUE INDEX invitations_current ON case_invitations(case_id,target_partner_role,purpose) WHERE revoked_at IS NULL;
CREATE TABLE app_auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE TABLE local_mailbox (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tasks_case_template ON case_tasks(case_id,task_template_id) WHERE task_template_id IS NOT NULL;
