-- BridalHub / にこまる — インデックス
-- 正本: 基本設計書 Version 1.2 6-4「インデックス設計（初期案）」。
-- venue_id／case_id を参照する外部キー列は自動でINDEXが張られないため明示的に作成する。
--
-- 部分ユニークインデックス（couple_profiles_primary_uk / case_invitations_active_uk /
-- task_submissions_latest_uk / timeline_items_*_uk / risk_score_snapshots_current_uk /
-- ai_prompt_templates_active_uk / risk_rules_venue_key_uk）は
-- 一意性制約としての意味を持つため、テーブル定義側に置いてある。

create index wedding_cases_venue_idx          on wedding_cases (venue_id);
create index wedding_cases_planner_idx        on wedding_cases (primary_planner_id);
create index wedding_cases_venue_status_idx   on wedding_cases (venue_id, status);

create index couple_profiles_user_idx         on couple_profiles (user_profile_id);
create index couple_profiles_case_idx         on couple_profiles (case_id);
create index couple_profiles_email_hash_idx   on couple_profiles (email_hash);

create index case_invitations_token_idx       on case_invitations (token_hash);
create index case_invitations_case_idx        on case_invitations (case_id);

create index case_guests_case_idx             on case_guests (case_id);

create index case_tasks_case_idx              on case_tasks (case_id);
create index case_tasks_case_status_idx       on case_tasks (case_id, status);
-- M01「次にやること」・M02 の既定並び順（ORDER BY due_date, display_order, id）
create index case_tasks_case_due_order_idx    on case_tasks (case_id, due_date, display_order);

create index task_submissions_task_idx        on task_submissions (case_task_id);

create index timeline_items_case_due_idx      on timeline_items (case_id, due_date);

create index storage_files_case_idx           on storage_files (case_id);

create index communication_logs_case_idx      on communication_logs (case_id);
create index follow_logs_case_idx             on follow_logs (case_id);

create index plan_types_venue_idx             on plan_types (venue_id);
create index task_templates_venue_idx         on task_templates (venue_id);
create index plan_task_templates_plan_idx     on plan_task_templates (plan_type_id);
create index plan_task_templates_template_idx on plan_task_templates (task_template_id);

create index notifications_case_status_idx    on notifications (case_id, status);
create index notifications_recipient_idx      on notifications (recipient_user_id);
create index notification_logs_notif_idx      on notification_logs (notification_id);

create index meeting_notes_case_idx           on meeting_notes (case_id);
create index meeting_sheets_case_idx          on meeting_sheets (case_id);

create index risk_score_snapshots_case_idx    on risk_score_snapshots (case_id);

create index audit_logs_actor_idx             on audit_logs (actor_user_id);
create index audit_logs_created_idx           on audit_logs (created_at);

-- ジョブキューのワーカー取得と滞留ジョブの回収（7-3、6-12）
create index ai_jobs_status_created_idx       on ai_jobs (status, created_at);
create index ai_jobs_status_locked_idx        on ai_jobs (status, locked_at);
create index ai_jobs_case_idx                 on ai_jobs (case_id);
