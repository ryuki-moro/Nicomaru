-- 席次（#178 epic 配下: #180 配置パターン / #181 席次作成・提出 / #182 承認・差し戻し）。
-- Supabase版 20261106000100_seating_layouts.sql / 20261107000100_seating_charts.sql を D1 (SQLite) へ翻訳したもの。
-- 書き込みは src/lib/d1/seating.ts の関数だけが行い、権限・条件・定員・版の検証はその関数とこの制約で行う
-- （D1 には RLS / DB 関数が無いため、Supabase版の security definer 関数の規則をアプリ層へ移した）。
--
--   seating_layouts      プランナーが作る卓の配置パターン。offered_at が NULL の間は新郎新婦に見えない
--   seating_tables       配置パターンの中の卓。行として持ち、保存し直しても ID が変わらない
--                        （席次の割り当てが卓 ID を参照するため）。allowed_tags はタグキーの JSON 配列
--   seating_charts       案件ごとに1行。選んだ配置・状態・版（version、楽観ロック）
--   seating_assignments  ゲストごとに1行。どの卓の何番目の席か（seat_order は卓の中で 0 から）
--
-- 状態: draft（作成中）→ submitted（提出済み）→ approved（確定）／ returned（修正のお願い → 再び編集可）
CREATE TABLE seating_layouts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0 AND length(name) <= 30),
  hall_shape TEXT NOT NULL CHECK(hall_shape IN ('wide', 'tall')),
  offered_at TEXT,
  created_by_user_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX seating_layouts_case ON seating_layouts(case_id, created_at, id);
CREATE TABLE seating_tables (
  id TEXT PRIMARY KEY,
  layout_id TEXT NOT NULL REFERENCES seating_layouts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0 AND length(name) <= 20),
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 2 AND 20),
  shape TEXT NOT NULL CHECK(shape IN ('round', 'rect', 'rectv')),
  pos_x REAL NOT NULL CHECK(pos_x BETWEEN 0 AND 1),
  pos_y REAL NOT NULL CHECK(pos_y BETWEEN 0 AND 1),
  allowed_tags TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX seating_tables_layout ON seating_tables(layout_id, sort_order, id);
CREATE TABLE seating_charts (
  case_id TEXT PRIMARY KEY REFERENCES wedding_cases(id) ON DELETE CASCADE,
  layout_id TEXT REFERENCES seating_layouts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'approved', 'returned')),
  version INTEGER NOT NULL DEFAULT 0,
  feedback TEXT,
  submitted_at TEXT,
  updated_by_user_id TEXT REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE seating_assignments (
  guest_id TEXT PRIMARY KEY REFERENCES case_guests(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES wedding_cases(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES seating_tables(id) ON DELETE CASCADE,
  seat_order INTEGER NOT NULL CHECK(seat_order >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX seating_assignments_case ON seating_assignments(case_id);
CREATE INDEX seating_assignments_table ON seating_assignments(table_id, seat_order);
