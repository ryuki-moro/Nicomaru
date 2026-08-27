-- BridalHub / にこまる — Phase 2 テーブル定義
-- 正本: 基本設計書 Version 1.2 5-3。
-- Phase 1 では画面・APIを実装しないが、リスクルール（risk_rules）は 12章の seed 対象であり、
-- 参照整合（meeting_sheets → ai_jobs）を成立させるためスキーマは先に作成する。

-- ---------------------------------------------------------- risk_rules リスクルール
create table risk_rules (
  id            uuid         primary key default gen_random_uuid(),
  venue_id      uuid         references venues(id) on delete cascade,
  name          varchar(120) not null,
  condition_key varchar(80)  not null,
  level         varchar(20)  not null,
  score_delta   integer      not null default 0,
  priority      integer      not null default 0,
  params        jsonb        not null default '{}'::jsonb,
  active        boolean      not null default true,
  description   text,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now(),
  constraint risk_rules_level_check check (level in ('low', 'caution', 'high')),
  constraint risk_rules_score_delta_check check (score_delta between 0 and 100)
);
comment on column risk_rules.condition_key is
  'コード側の判定関数と1対1で対応させる。対応表に無いキーは無視する（6-8）';
comment on column risk_rules.params is
  '判定閾値をコードに直書きせず設定値として保持する（例 {"within_days":30}）';

-- venue_id が NULL の共通ルールも含め、condition_key は式場ごとに1件
create unique index risk_rules_venue_key_uk
  on risk_rules (coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), condition_key);

-- ----------------------------------------- risk_score_snapshots リスク算出結果
create table risk_score_snapshots (
  id            uuid        primary key default gen_random_uuid(),
  case_id       uuid        not null references wedding_cases(id) on delete cascade,
  risk_rule_id  uuid        references risk_rules(id) on delete set null,
  score_value   integer     not null,
  score_level   varchar(20) not null,
  reasons       jsonb       not null default '[]'::jsonb,
  is_current    boolean     not null default true,
  calculated_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  constraint risk_score_snapshots_value_check check (score_value between 0 and 100),
  constraint risk_score_snapshots_level_check check (score_level in ('low', 'caution', 'high'))
);
create unique index risk_score_snapshots_current_uk
  on risk_score_snapshots (case_id) where is_current;

-- ------------------------------------------------------------- notifications 通知
create table notifications (
  id                uuid         primary key default gen_random_uuid(),
  venue_id          uuid         not null references venues(id),
  case_id           uuid         references wedding_cases(id) on delete cascade,
  recipient_user_id uuid         not null references user_profiles(id),
  created_by        uuid         references user_profiles(id),
  channel           varchar(20)  not null,
  notification_type varchar(30)  not null,
  title             varchar(120) not null,
  body              text         not null,
  status            varchar(20)  not null default 'queued',
  scheduled_at      timestamptz,
  sent_at           timestamptz,
  read_at           timestamptz,
  created_at        timestamptz  not null default now(),
  constraint notifications_channel_check check (channel in ('line', 'email', 'in_app')),
  constraint notifications_type_check
    check (notification_type in ('due_reminder', 'overdue', 'submission_request',
                                 'needs_fix', 'info', 'invitation')),
  constraint notifications_status_check
    check (status in ('queued', 'sent', 'failed', 'read', 'cancelled', 'skipped'))
);
comment on column notifications.status is 'skipped は送信上限超過により送信を見送った状態（6-9）';

-- ---------------------------------------------------- notification_logs 通知送信ログ
create table notification_logs (
  id                  uuid         primary key default gen_random_uuid(),
  notification_id     uuid         not null references notifications(id) on delete cascade,
  provider            varchar(20)  not null,
  provider_message_id varchar(128),
  response_json       jsonb,
  status              varchar(20)  not null,
  attempt_no          integer      not null default 1,
  created_at          timestamptz  not null default now(),
  constraint notification_logs_provider_check check (provider in ('line', 'email')),
  constraint notification_logs_status_check check (status in ('success', 'failure'))
);

-- ----------------------------------------------------- meeting_notes 打ち合わせ記録
create table meeting_notes (
  id           uuid        primary key default gen_random_uuid(),
  case_id      uuid        not null references wedding_cases(id) on delete cascade,
  created_by   uuid        not null references user_profiles(id),
  meeting_date date,
  participants text,
  body         text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------- ai_jobs AIジョブ
-- Phase 3 の実装対象だが、meeting_sheets.ai_draft_job_id の参照先として先に定義する（5-4）。
create table ai_prompt_templates (
  id          uuid         primary key default gen_random_uuid(),
  venue_id    uuid         references venues(id) on delete cascade,
  job_type    varchar(20)  not null,
  name        varchar(120) not null,
  model_name  varchar(80),
  prompt_text text         not null,
  version     integer      not null default 1,
  active      boolean      not null default true,
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now(),
  constraint ai_prompt_templates_job_type_check
    check (job_type in ('classification', 'draft', 'defect_check', 'task_extraction',
                        'faq_answer', 'reschedule_plan', 'handover_summary',
                        'template_draft', 'translation')),
  constraint ai_prompt_templates_version_uk unique (venue_id, job_type, version)
);
create unique index ai_prompt_templates_active_uk
  on ai_prompt_templates (coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), job_type)
  where active;

create table ai_jobs (
  id                  uuid        primary key default gen_random_uuid(),
  venue_id            uuid        not null references venues(id),
  case_id             uuid        references wedding_cases(id) on delete cascade,
  related_task_id     uuid        references case_tasks(id) on delete cascade,
  job_type            varchar(20) not null,
  input_ref           jsonb       not null,
  output              jsonb,
  status              varchar(20) not null default 'queued',
  model_name          varchar(80),
  prompt_template_id  uuid        references ai_prompt_templates(id) on delete set null,
  attempts            integer     not null default 0,
  started_at          timestamptz,
  finished_at         timestamptz,
  locked_by           varchar(80),
  locked_at           timestamptz,
  confirmed_by        uuid        references user_profiles(id),
  confirmed_at        timestamptz,
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint ai_jobs_job_type_check
    check (job_type in ('classification', 'draft', 'defect_check', 'task_extraction',
                        'faq_answer', 'reschedule_plan', 'handover_summary',
                        'template_draft', 'translation')),
  constraint ai_jobs_status_check
    check (status in ('queued', 'processing', 'done', 'failed', 'confirmed', 'discarded'))
);
comment on column ai_jobs.input_ref is
  '入力参照（テーブル名・id）。本文テキストは永続化しない（7-4）';

-- --------------------------------------------- meeting_sheets 打ち合わせ前準備シート
create table meeting_sheets (
  id                  uuid        primary key default gen_random_uuid(),
  case_id             uuid        not null references wedding_cases(id) on delete cascade,
  generated_by        uuid        not null references user_profiles(id),
  target_meeting_date date,
  summary_json        jsonb       not null default '{}'::jsonb,
  ai_draft_job_id     uuid        references ai_jobs(id) on delete set null,
  pdf_file_id         uuid        references storage_files(id) on delete set null,
  generated_at        timestamptz not null default now(),
  created_at          timestamptz not null default now()
);
