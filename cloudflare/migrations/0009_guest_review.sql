-- 新郎新婦によるゲスト一覧の確認（#179、Supabase版 20261105000100 と同じ内容）。
-- 席次に入れるのは「出席」かつ確認済み（checked_at あり）の人。回答の relationship は上書きせず、
-- 直したご関係は relationship_override に持つ。
ALTER TABLE case_guests ADD COLUMN checked_at TEXT;
ALTER TABLE case_guests ADD COLUMN relationship_override TEXT CHECK(relationship_override IS NULL OR relationship_override IN ('family','relative','friend','colleague','teacher','other'));
ALTER TABLE case_guests ADD COLUMN seat_role TEXT CHECK(seat_role IS NULL OR seat_role IN ('chief','toast'));
ALTER TABLE case_guests ADD COLUMN seat_title TEXT CHECK(seat_title IS NULL OR (length(trim(seat_title)) > 0 AND length(seat_title) <= 30));
