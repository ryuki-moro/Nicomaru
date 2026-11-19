-- ゲストの出欠回答と自由タグ（Supabase版 20261030000100〜300 と同じ内容）。
-- 氏名・ふりがな・アレルギー・ご事情の補足・回答URLの暗号文はアプリ側で暗号化して入れる。
CREATE TABLE case_guests (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL, kana TEXT, relationship TEXT, allergy_note TEXT,
  invitation_status TEXT NOT NULL CHECK(invitation_status IN ('reply_yes','reply_no')),
  response_group_id TEXT NOT NULL, is_companion INTEGER NOT NULL CHECK(is_companion IN (0,1)),
  guest_side TEXT CHECK(guest_side IS NULL OR guest_side IN ('groom','bride')),
  age_category TEXT CHECK(age_category IS NULL OR age_category IN ('adult','child','infant')),
  gender TEXT CHECK(gender IS NULL OR gender IN ('male','female','unspecified')),
  assistance_needs TEXT NOT NULL DEFAULT '[]', assistance_note TEXT,
  responded_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX case_guests_case ON case_guests(case_id,response_group_id);
CREATE TABLE case_guest_forms (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, token_enc TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES user_profiles(id), revoked_at TEXT, created_at TEXT NOT NULL
);
-- 有効な回答URLは案件ごとに1本
CREATE UNIQUE INDEX case_guest_forms_active ON case_guest_forms(case_id) WHERE revoked_at IS NULL;
CREATE TABLE case_guest_tags (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX case_guest_tags_name ON case_guest_tags(case_id,lower(trim(name)));
CREATE TABLE case_guest_tag_links (
  guest_id TEXT NOT NULL REFERENCES case_guests(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES case_guest_tags(id) ON DELETE CASCADE,
  PRIMARY KEY(guest_id,tag_id)
);
CREATE INDEX case_guest_tag_links_tag ON case_guest_tag_links(tag_id);
