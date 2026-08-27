-- BridalHub / にこまる — 初期データ（seed）
-- 正本: 基本設計書 Version 1.2 12章「初期データ・セットアップ設計」。
--   (a) venues 1件・plan_types（K03 の4種）・task_templates 初期セット・plan_task_templates・
--       risk_rules（表6-8 の5条件を実値で）を投入する。
--   (b) system_admin 初期アカウントは Supabase Auth のユーザー作成を伴うため
--       scripts/bootstrap-system-admin.ts で作成する（本ファイルでは auth.users を作らない）。
--
-- 冪等: 何度流しても同じ状態になるよう on conflict do nothing / do update を用いる。

-- ------------------------------------------------------------------- 式場（1件）
insert into venues (id, name, code, contact_email)
values ('11111111-1111-4111-8111-111111111111', 'にこまる実証式場', 'BRIDAL01', 'venue@example.test')
on conflict (code) do nothing;

-- ---------------------------------------------------- プラン種別（K03 の選択肢4種）
insert into plan_types (id, venue_id, name, description,
                        default_guest_count_min, default_guest_count_max, display_order)
values
  ('21111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
   '少人数婚', '20名程度までの少人数での挙式・会食', 2, 20, 1),
  ('21111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111111',
   '家族婚', '両家family中心の挙式・会食', 2, 30, 2),
  ('21111111-1111-4111-8111-111111111113', '11111111-1111-4111-8111-111111111111',
   'フォト婚', '挙式を伴わない写真撮影プラン', 2, 10, 3),
  ('21111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111111',
   '一般挙式', '挙式・披露宴の標準プラン', 30, 120, 4)
on conflict (venue_id, name) do nothing;

-- ---------------------------------------------------------- 宿題テンプレート初期セット
-- due_offset_days は挙式日から何日前を期限にするか（6-6-2）。
-- submission_format は表6-9 の値域（text／select／file／none）に従い、
-- ファイルの受入種別は allowed_file_types で表現する（csv／image を混在させない）。
insert into task_templates (id, venue_id, name, description, submission_format,
                            allowed_file_types, due_offset_days, importance,
                            default_options, is_required)
values
  ('31111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111111',
   'ゲストリスト提出', '招待するゲストのお名前・ご住所をCSVでご提出ください。',
   'file', '["csv"]'::jsonb, 60, 'critical', '{}'::jsonb, true),
  ('31111111-1111-4111-8111-111111111102', '11111111-1111-4111-8111-111111111111',
   '席次表の確認', '席次表の最終確認をお願いします。',
   'file', '["jpg","png"]'::jsonb, 21, 'critical', '{}'::jsonb, true),
  ('31111111-1111-4111-8111-111111111103', '11111111-1111-4111-8111-111111111111',
   'BGMリクエスト', '入場・歓談・退場で流したい曲をご記入ください。',
   'text', '[]'::jsonb, 45, 'normal', '{}'::jsonb, true),
  ('31111111-1111-4111-8111-111111111104', '11111111-1111-4111-8111-111111111111',
   '料理コースの選択', 'ご列席者にお出しするお料理のコースをお選びください。',
   'select', '[]'::jsonb, 40, 'important',
   '{"choices":["スタンダード","グレードアップ","シェフのおまかせ"]}'::jsonb, true),
  ('31111111-1111-4111-8111-111111111105', '11111111-1111-4111-8111-111111111111',
   '引き出物の選択', '引き出物・引き菓子をお選びください。',
   'select', '[]'::jsonb, 35, 'important',
   '{"choices":["カタログギフトA","カタログギフトB","食器セット"]}'::jsonb, true),
  ('31111111-1111-4111-8111-111111111106', '11111111-1111-4111-8111-111111111111',
   'プロフィールムービーの入稿', 'プロフィールムービーで使用するお写真をご提出ください。',
   'file', '["jpg","png"]'::jsonb, 30, 'normal', '{}'::jsonb, false),
  ('31111111-1111-4111-8111-111111111107', '11111111-1111-4111-8111-111111111111',
   '当日の進行表の確認', '当日の進行表をご確認ください。ご質問があればお知らせください。',
   'none', '[]'::jsonb, 14, 'important', '{}'::jsonb, true),
  ('31111111-1111-4111-8111-111111111108', '11111111-1111-4111-8111-111111111111',
   '最終お支払いのご確認', 'お支払い金額の最終確認です。',
   'none', '[]'::jsonb, 7, 'critical', '{}'::jsonb, true)
on conflict (venue_id, name) do nothing;

-- -------------------------------------------------------- プラン別宿題テンプレート
-- 少人数婚・家族婚・一般挙式は共通セット。フォト婚は挙式を伴わないため対象を絞る。
insert into plan_task_templates (plan_type_id, task_template_id, display_order,
                                 is_required, due_offset_days_override)
select p.id, t.id, t.ord, t.req, t.override
from (values ('21111111-1111-4111-8111-111111111111'::uuid),
             ('21111111-1111-4111-8111-111111111112'::uuid),
             ('21111111-1111-4111-8111-111111111114'::uuid)) as p(id)
cross join (values
  ('31111111-1111-4111-8111-111111111101'::uuid, 1, true,  null::integer),
  ('31111111-1111-4111-8111-111111111102'::uuid, 2, true,  null),
  ('31111111-1111-4111-8111-111111111103'::uuid, 3, true,  null),
  ('31111111-1111-4111-8111-111111111104'::uuid, 4, true,  null),
  ('31111111-1111-4111-8111-111111111105'::uuid, 5, true,  null),
  ('31111111-1111-4111-8111-111111111106'::uuid, 6, false, null),
  ('31111111-1111-4111-8111-111111111107'::uuid, 7, true,  null),
  ('31111111-1111-4111-8111-111111111108'::uuid, 8, true,  null)
) as t(id, ord, req, override)
on conflict (plan_type_id, task_template_id) do nothing;

insert into plan_task_templates (plan_type_id, task_template_id, display_order,
                                 is_required, due_offset_days_override)
values
  ('21111111-1111-4111-8111-111111111113', '31111111-1111-4111-8111-111111111106', 1, false, 21),
  ('21111111-1111-4111-8111-111111111113', '31111111-1111-4111-8111-111111111107', 2, true,  10),
  ('21111111-1111-4111-8111-111111111113', '31111111-1111-4111-8111-111111111108', 3, true,  7)
on conflict (plan_type_id, task_template_id) do nothing;

-- --------------------------------------------------------- リスクルール（表6-8）
-- venue_id が NULL のものはシステム共通ルール。
-- condition_key はコード側の判定関数と1対1で対応する（src/lib/services/risk.ts）。
-- score_level は成立ルール中の最も高い level、risk_rule_id は priority 最大のものを記録する（6-8）。
insert into risk_rules (venue_id, name, condition_key, level, score_delta, priority, params, description)
values
  (null, '挙式30日以内で重要宿題が未提出', 'important_task_overdue', 'high',   30, 40,
   '{"within_days":30}'::jsonb, '挙式日が近く、重要な宿題が未提出です'),
  (null, '期限超過の未提出宿題がある',     'task_overdue',           'high',   40, 30,
   '{}'::jsonb,                  '提出期限を過ぎた宿題があります'),
  (null, '7日以上やり取りが無く未完了あり', 'no_activity_days',       'caution', 20, 20,
   '{"no_activity_days":7}'::jsonb, '最後のやり取りから日数が経っています'),
  (null, '不備ありの宿題がある',           'needs_fix_exists',       'caution', 15, 10,
   '{}'::jsonb,                  '再提出をお願いしている宿題があります')
on conflict (coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), condition_key)
do update set level       = excluded.level,
              score_delta = excluded.score_delta,
              priority    = excluded.priority,
              params      = excluded.params,
              description = excluded.description;
