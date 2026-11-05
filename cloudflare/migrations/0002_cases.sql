CREATE TABLE venues (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE user_profiles (
  id TEXT PRIMARY KEY REFERENCES "user"(id),
  venue_id TEXT REFERENCES venues(id),
  role TEXT NOT NULL CHECK(role IN ('system_admin','admin','planner','couple')),
  status TEXT NOT NULL CHECK(status IN ('active','invited','suspended','deleted')),
  CHECK (role = 'system_admin' OR venue_id IS NOT NULL)
);
CREATE TABLE plan_types (
  id TEXT PRIMARY KEY, venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  templates_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE wedding_cases (
  id TEXT PRIMARY KEY, venue_id TEXT NOT NULL REFERENCES venues(id),
  primary_planner_id TEXT NOT NULL REFERENCES user_profiles(id),
  plan_type_id TEXT REFERENCES plan_types(id), case_code TEXT NOT NULL UNIQUE,
  wedding_date TEXT NOT NULL, wedding_time TEXT, contact_channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'active', guest_count INTEGER, venue_room TEXT, notes TEXT,
  archived_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX cases_venue_planner ON wedding_cases(venue_id,primary_planner_id);
CREATE TABLE couple_profiles (
  case_id TEXT NOT NULL REFERENCES wedding_cases(id), partner_role TEXT NOT NULL,
  user_id TEXT REFERENCES user_profiles(id), full_name TEXT NOT NULL, email TEXT,
  is_primary_contact INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(case_id,partner_role), UNIQUE(user_id)
);
CREATE TABLE case_tasks (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wedding_cases(id),
  task_template_id TEXT, title TEXT NOT NULL, due_date TEXT NOT NULL,
  due_offset_days INTEGER, status TEXT NOT NULL DEFAULT 'not_started',
  importance TEXT NOT NULL DEFAULT 'normal', display_order INTEGER NOT NULL DEFAULT 0,
  submission_format TEXT NOT NULL DEFAULT 'text', phase_name TEXT
);
CREATE INDEX tasks_case ON case_tasks(case_id);
CREATE TABLE case_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE wedding_cases ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
