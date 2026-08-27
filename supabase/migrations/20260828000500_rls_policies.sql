-- BridalHub / にこまる — RLS ポリシー
-- 正本: 基本設計書 Version 1.2 付録A。本ファイルは 12-2 の「人手レビュー必須領域」の最優先対象。
--
-- 前提（付録A 冒頭）:
--   (1) 論理削除の除外は as restrictive で AND 結合する。
--       permissive として書くと他ポリシーと OR されて素通りする。
--   (2) ポリシー式から user_profiles／couple_profiles／wedding_cases を直接参照せず、
--       必ず 20260828000400_functions.sql の security definer 関数を経由する。
--
-- ポリシー未定義のテーブルはデフォルト全拒否（6-3-3）。

-- ------------------------------------------------------------------ ロールと権限
-- Supabase では anon／authenticated ロールが既に存在する。ローカル検証環境向けに冪等化する。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke execute on all functions in schema public from public;
grant execute on function
  current_app_user(), is_system_admin(), is_admin_of(uuid), accessible_case_ids(),
  can_see_archived(), case_is_visible(uuid), plan_type_venue(uuid), notification_owner(uuid),
  get_couple_memo(uuid), submit_task(uuid, text), log_audit(text, text, uuid, jsonb)
  to authenticated;

-- next_case_code／check_rate_limit はサーバー側（Service Role）専用。authenticated には付与しない。

-- ============================================================ 1. user_profiles
-- role・venue_id は権限判定の入力なので、本人経路では変更させない。
alter table user_profiles enable row level security;

create policy user_profiles_select on user_profiles
  for select using (auth_user_id = auth.uid() or is_admin_of(venue_id) or is_system_admin());

-- 本人が変更してよいのは表示名・電話のみ。role／venue_id／status の改変を WITH CHECK で拒否する。
create policy user_profiles_update_self on user_profiles
  for update
  using (auth_user_id = auth.uid())
  with check (
    auth_user_id = auth.uid()
    and role     = (select u.role from current_app_user() u)
    and venue_id is not distinct from (select u.venue_id from current_app_user() u)
    and status   = 'active'
  );

-- admin／system_admin による利用者管理。作れる role を列挙して権限昇格を塞ぐ。
-- v1.2: system_admin が作れるのは admin のみ（U02 表4-19 の自動設定規則と一致させる）。
create policy user_profiles_admin_write on user_profiles
  for all
  using (is_admin_of(venue_id) or is_system_admin())
  with check (
       (is_admin_of(venue_id) and role = 'planner'
        and venue_id = (select u.venue_id from current_app_user() u))
    or (is_system_admin() and role = 'admin')
  );

-- ============================================================ 2. wedding_cases
alter table wedding_cases enable row level security;

create policy cases_select on wedding_cases
  for select using (id in (select accessible_case_ids()));

create policy cases_insert on wedding_cases
  for insert with check (exists (select 1 from current_app_user() u
                                  where u.role in ('planner', 'admin')
                                    and u.venue_id = wedding_cases.venue_id));

create policy cases_update on wedding_cases
  for update using (id in (select accessible_case_ids()))
  with check (id in (select accessible_case_ids()));

-- 物理削除は行わない（2-5 はアーカイブ）
create policy cases_delete on wedding_cases for delete using (false);

-- select だけでなく update／delete にも掛ける
create policy cases_exclude_archived on wedding_cases
  as restrictive for all
  using      (archived_at is null or can_see_archived())
  with check (archived_at is null or can_see_archived());

-- ========================================================== 3. couple_profiles
-- 案件登録直後は user_profile_id が NULL のため、user_profile_id 一致で判定すると
-- K01 のカップル名・K02 の新郎新婦氏名・D01 の一覧がすべて0行になる。case_id ベースで判定する。
alter table couple_profiles enable row level security;

create policy couple_profiles_select on couple_profiles
  for select using (case_id in (select accessible_case_ids()));

-- v1.2: 書き込みは staff のみ。couple は参照のみ（M06 の本人編集は Phase 2 に専用関数で追加）。
create policy couple_profiles_insert_staff on couple_profiles
  for insert with check (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and exists (select 1 from current_app_user() u
                 where u.role in ('planner', 'admin', 'system_admin')));

create policy couple_profiles_update_staff on couple_profiles
  for update
  using (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and exists (select 1 from current_app_user() u
                 where u.role in ('planner', 'admin', 'system_admin')))
  with check (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and exists (select 1 from current_app_user() u
                 where u.role in ('planner', 'admin', 'system_admin')));

create policy couple_profiles_delete on couple_profiles for delete using (false);

-- 行レベルポリシーでは列を隠せないため、memo は列レベル権限で剥奪する（付録A／6-3-3）。
revoke select on couple_profiles from authenticated;
grant select (id, case_id, user_profile_id, partner_role, full_name, kana, email, email_hash,
              phone, address, is_primary_contact, created_at, updated_at)
  on couple_profiles to authenticated;

-- ======================================================= 4. case_invitations
-- v1.2 追加。ポリシー未定義のままでは K02 の招待状況セクションが 0 行になる。
alter table case_invitations enable row level security;

create policy case_invitations_select on case_invitations
  for select using (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and exists (select 1 from current_app_user() u
                 where u.role in ('planner', 'admin', 'system_admin')));

create policy case_invitations_insert on case_invitations
  for insert with check (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and exists (select 1 from current_app_user() u
                 where u.role in ('planner', 'admin', 'system_admin')));

create policy case_invitations_update on case_invitations
  for update
  using (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and exists (select 1 from current_app_user() u
                 where u.role in ('planner', 'admin', 'system_admin')))
  with check (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and exists (select 1 from current_app_user() u
                 where u.role in ('planner', 'admin', 'system_admin')));

create policy case_invitations_delete on case_invitations for delete using (false);

-- ================================================ 5. case_tasks / task_submissions
-- 親を辿らず accessible_case_ids() と case_is_visible() を使う。
alter table case_tasks enable row level security;

create policy case_tasks_select on case_tasks
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id));

-- 宿題の追加・期限変更・waived 付与は planner／admin のみ（機能5-5）。
-- couple の提出に伴う status 更新は submit_task() に集約する。
create policy case_tasks_write on case_tasks
  for all
  using (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
         and exists (select 1 from current_app_user() u
                      where u.role in ('planner', 'admin', 'system_admin')))
  with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
         and exists (select 1 from current_app_user() u
                      where u.role in ('planner', 'admin', 'system_admin')));

alter table task_submissions enable row level security;

create policy task_submissions_select on task_submissions
  for select using (exists (select 1 from case_tasks ct
                             where ct.id = task_submissions.case_task_id
                               and ct.case_id in (select accessible_case_ids())
                               and case_is_visible(ct.case_id)));

-- 一時保存（draft）は本人以外に見せない
create policy task_submissions_hide_draft on task_submissions
  as restrictive for select
  using (review_status <> 'draft'
         or submitted_by = (select u.id from current_app_user() u));

-- couple は自分の提出のみ insert／update 可。review_status の確定は planner のみ。
create policy task_submissions_insert_couple on task_submissions
  for insert with check (
    submitted_by = (select u.id from current_app_user() u)
    and exists (select 1 from case_tasks ct
                 where ct.id = case_task_id
                   and ct.case_id in (select accessible_case_ids()))
    and review_status in ('draft', 'submitted'));

-- v1.2 追加: 未レビュー提出（draft／submitted）の上書きを couple に許可する（6-7）
create policy task_submissions_update_couple on task_submissions
  for update
  using  (submitted_by = (select u.id from current_app_user() u)
          and review_status in ('draft', 'submitted'))
  with check (submitted_by = (select u.id from current_app_user() u)
          and review_status in ('draft', 'submitted'));

-- WITH CHECK にもロール条件を含める。
-- permissive ポリシーの WITH CHECK は OR 結合されるため、ここを値域だけにすると
-- couple が task_submissions_update_couple の USING で行を掴んだうえで
-- 本ポリシーの WITH CHECK を満たしてしまい、自分の提出を confirmed にできる（権限昇格）。
create policy task_submissions_review_planner on task_submissions
  for update
  using (exists (select 1 from case_tasks ct, current_app_user() u
                  where ct.id = task_submissions.case_task_id
                    and ct.case_id in (select accessible_case_ids())
                    and u.role in ('planner', 'admin', 'system_admin')))
  with check (review_status in ('needs_fix', 'confirmed')
              and exists (select 1 from case_tasks ct, current_app_user() u
                           where ct.id = task_submissions.case_task_id
                             and ct.case_id in (select accessible_case_ids())
                             and u.role in ('planner', 'admin', 'system_admin')));

create policy task_submissions_delete on task_submissions for delete using (false);

-- ============================================================== 6. audit_logs
-- 参照は system_admin のみ、書き込みは log_audit() 経由のみ（9-1）。
alter table audit_logs enable row level security;
create policy audit_logs_select on audit_logs for select using (is_system_admin());
-- insert／update／delete のポリシーは定義しない（＝全拒否。自分の操作記録を消せない）
revoke insert, update, delete on audit_logs from authenticated;

-- ================================================================= 7. venues
alter table venues enable row level security;
create policy venues_select on venues
  for select using (is_system_admin() or id = (select u.venue_id from current_app_user() u));
create policy venues_write on venues
  for all using (is_system_admin()) with check (is_system_admin());

-- ============================================ 8. venue_id を持つマスタテーブル
-- 参照は同式場の planner にも許可し、更新は admin／system_admin に限る（付録A）。
alter table plan_types enable row level security;
create policy plan_types_select on plan_types
  for select using (is_system_admin() or venue_id = (select u.venue_id from current_app_user() u));
create policy plan_types_write on plan_types
  for all using (is_admin_of(venue_id) or is_system_admin())
  with check (is_admin_of(venue_id) or is_system_admin());

alter table task_templates enable row level security;
create policy task_templates_select on task_templates
  for select using (is_system_admin() or venue_id = (select u.venue_id from current_app_user() u));
create policy task_templates_write on task_templates
  for all using (is_admin_of(venue_id) or is_system_admin())
  with check (is_admin_of(venue_id) or is_system_admin());

-- plan_task_templates は venue_id を持たないため、plan_type_venue() で解決する（付録A）。
alter table plan_task_templates enable row level security;
create policy plan_task_templates_select on plan_task_templates
  for select using (is_system_admin()
                    or plan_type_venue(plan_type_id) = (select u.venue_id from current_app_user() u));
create policy plan_task_templates_write on plan_task_templates
  for all using (is_system_admin() or is_admin_of(plan_type_venue(plan_type_id)))
  with check (is_system_admin() or is_admin_of(plan_type_venue(plan_type_id)));

alter table risk_rules enable row level security;
create policy risk_rules_select on risk_rules
  for select using (is_system_admin()
                    or venue_id is null
                    or venue_id = (select u.venue_id from current_app_user() u));
create policy risk_rules_write on risk_rules
  for all using (is_system_admin() or (venue_id is not null and is_admin_of(venue_id)))
  with check (is_system_admin() or (venue_id is not null and is_admin_of(venue_id)));

alter table ai_prompt_templates enable row level security;
create policy ai_prompt_templates_select on ai_prompt_templates
  for select using (is_system_admin()
                    or venue_id is null
                    or venue_id = (select u.venue_id from current_app_user() u));
create policy ai_prompt_templates_write on ai_prompt_templates
  for all using (is_system_admin()) with check (is_system_admin());

-- ================================================ 9. case_id を持つ業務テーブル
-- 共通条件: case_id in (select accessible_case_ids()) and case_is_visible(case_id)

alter table case_guests enable row level security;
create policy case_guests_all on case_guests
  for all using (case_id in (select accessible_case_ids()) and case_is_visible(case_id))
  with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id));

alter table timeline_items enable row level security;
create policy timeline_items_select on timeline_items
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id));
create policy timeline_items_write on timeline_items
  for all using (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')))
  with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')));

alter table storage_files enable row level security;
create policy storage_files_select on storage_files
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id));
create policy storage_files_insert on storage_files
  for insert with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                         and uploaded_by = (select u.id from current_app_user() u));
-- planner_only（D03 の生成PDF 等）は couple に見せない（6-11）
create policy storage_files_hide_planner_only on storage_files
  as restrictive for select
  using (visibility <> 'planner_only'
         or exists (select 1 from current_app_user() u
                     where u.role in ('planner', 'admin', 'system_admin')));

alter table communication_logs enable row level security;
create policy communication_logs_select on communication_logs
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                    and exists (select 1 from current_app_user() u
                                 where u.role in ('planner', 'admin', 'system_admin')));

alter table follow_logs enable row level security;
create policy follow_logs_all on follow_logs
  for all using (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')))
  with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')));

alter table meeting_notes enable row level security;
create policy meeting_notes_all on meeting_notes
  for all using (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')))
  with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')));

alter table meeting_sheets enable row level security;
create policy meeting_sheets_all on meeting_sheets
  for all using (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')))
  with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')));

alter table notifications enable row level security;
create policy notifications_select on notifications
  for select using (recipient_user_id = (select u.id from current_app_user() u)
                    or is_admin_of(venue_id)
                    or is_system_admin()
                    or (case_id in (select accessible_case_ids())
                        and exists (select 1 from current_app_user() u where u.role = 'planner')));
-- 既読化のみ受信者に許可する
create policy notifications_update_recipient on notifications
  for update
  using  (recipient_user_id = (select u.id from current_app_user() u))
  with check (recipient_user_id = (select u.id from current_app_user() u));

alter table notification_logs enable row level security;
create policy notification_logs_select on notification_logs
  for select using (exists (select 1 from notification_owner(notification_id) o
                             where o.recipient_user_id = (select u.id from current_app_user() u)
                                or is_admin_of(o.venue_id)
                                or is_system_admin()));

-- ai_jobs は例外として、couple には自案件かつ job_type='faq_answer' の行のみ select を許可する（7-3）。
alter table ai_jobs enable row level security;
create policy ai_jobs_select on ai_jobs
  for select using (
    case_id in (select accessible_case_ids())
    and (exists (select 1 from current_app_user() u
                  where u.role in ('planner', 'admin', 'system_admin'))
         or job_type = 'faq_answer'));
create policy ai_jobs_write on ai_jobs
  for all using (case_id in (select accessible_case_ids())
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')))
  with check (case_id in (select accessible_case_ids())
                 and exists (select 1 from current_app_user() u
                              where u.role in ('planner', 'admin', 'system_admin')));

alter table risk_score_snapshots enable row level security;
create policy risk_score_snapshots_select on risk_score_snapshots
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id)
                    and exists (select 1 from current_app_user() u
                                 where u.role in ('planner', 'admin', 'system_admin')));

-- ==================================================== 10. auth_rate_limits
-- アプリから直接参照させず、check_rate_limit() 経由のみとする（付録A）。
alter table auth_rate_limits enable row level security;
revoke select, insert, update, delete on auth_rate_limits from authenticated;
