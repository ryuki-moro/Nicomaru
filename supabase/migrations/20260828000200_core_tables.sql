-- BridalHub / にこまる — Phase 1 テーブル定義
-- 正本: 基本設計書 Version 1.2 5-3「カラム定義」。列の追加・変更はマイグレーション経由のみ（12-2）。
--
-- 命名規約（5-1）: スネークケース・テーブル名は複数形。
-- 削除方針（5-1）: 案件は物理削除せず status='archived' と archived_at で論理削除する。

-- ---------------------------------------------------------------- venues 式場
create table venues (
  id                        uuid primary key default gen_random_uuid(),
  name                      varchar(100) not null,
  code                      varchar(50)  not null unique,
  official_line_channel_id  varchar(128) unique,
  contact_email             varchar(255),
  active                    boolean      not null default true,
  created_at                timestamptz  not null default now(),
  updated_at                timestamptz  not null default now(),
  constraint venues_code_format check (code ~ '^[A-Z0-9]{4,10}$')
);
comment on table venues is '式場。venues.code の採番規約は 5-7';

-- ------------------------------------------------- user_profiles 利用者プロフィール
create table user_profiles (
  id            uuid        primary key default gen_random_uuid(),
  auth_user_id  uuid        not null unique references auth.users(id) on delete cascade,
  venue_id      uuid        references venues(id),
  role          varchar(20) not null,
  display_name  varchar(100) not null,
  email         varchar(255) not null unique,
  phone         varchar(30),
  line_user_id  varchar(128) unique,
  status        varchar(20) not null default 'active',
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint user_profiles_role_check
    check (role in ('couple', 'planner', 'admin', 'system_admin')),
  constraint user_profiles_status_check
    check (status in ('active', 'invited', 'suspended', 'deleted')),
  -- system_admin のみ venue_id が NULL。RLS は venue_id ではなく role で判定する（6-3-4）
  constraint user_profiles_venue_scope_check
    check ((role = 'system_admin' and venue_id is null)
        or (role <> 'system_admin' and venue_id is not null))
);
comment on column user_profiles.display_name is
  '画面表示名。couple の氏名の正本は couple_profiles.full_name（5-1）。P02 の入力はこの列にのみ設定する（6-6-1）';
comment on column user_profiles.status is
  'RLS共通関数 current_app_user() が active を必須条件とする（6-3-4）。invited は初回パスワード設定前';

-- ------------------------------------------------------------ plan_types プラン種別
create table plan_types (
  id                        uuid         primary key default gen_random_uuid(),
  venue_id                  uuid         not null references venues(id),
  name                      varchar(100) not null,
  description               text,
  default_guest_count_min   integer      default 0,
  default_guest_count_max   integer,
  display_order             integer      not null default 0,
  active                    boolean      not null default true,
  created_at                timestamptz  not null default now(),
  updated_at                timestamptz  not null default now(),
  constraint plan_types_venue_name_uk unique (venue_id, name),
  constraint plan_types_guest_min_check check (default_guest_count_min >= 0),
  constraint plan_types_guest_max_check
    check (default_guest_count_max is null
           or default_guest_count_max >= coalesce(default_guest_count_min, 0))
);

-- -------------------------------------------------------------- wedding_cases 案件
create table wedding_cases (
  id                 uuid         primary key default gen_random_uuid(),
  venue_id           uuid         not null references venues(id),
  plan_type_id       uuid         references plan_types(id) on delete set null,
  primary_planner_id uuid         not null references user_profiles(id),
  case_code          varchar(50)  not null,
  wedding_date       date         not null,
  wedding_time       time,
  contact_channel    varchar(10)  not null default 'email',
  status             varchar(20)  not null default 'active',
  guest_count        integer      default 0,
  venue_room         varchar(100),
  notes              text,
  archived_at        timestamptz,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),
  constraint wedding_cases_code_uk unique (venue_id, case_code),
  constraint wedding_cases_channel_check check (contact_channel in ('line', 'email')),
  constraint wedding_cases_status_check
    check (status in ('draft', 'active', 'completed', 'archived')),
  constraint wedding_cases_guest_count_check check (guest_count >= 0),
  -- 論理削除の整合: archived のときだけ archived_at を持つ（K05／2-5）
  constraint wedding_cases_archived_consistency_check
    check ((status = 'archived' and archived_at is not null)
        or (status <> 'archived' and archived_at is null))
);

-- ----------------------------------------------- couple_profiles カップルプロフィール
create table couple_profiles (
  id                 uuid        primary key default gen_random_uuid(),
  case_id            uuid        not null references wedding_cases(id) on delete cascade,
  user_profile_id    uuid        unique references user_profiles(id),
  partner_role       varchar(20) not null,
  full_name          text        not null,
  kana               text,
  email              text,
  email_hash         text,
  phone              text,
  address            text,
  is_primary_contact boolean     not null default false,
  memo               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint couple_profiles_case_role_uk unique (case_id, partner_role),
  constraint couple_profiles_partner_role_check
    check (partner_role in ('groom', 'bride', 'partner_a', 'partner_b'))
);
comment on column couple_profiles.full_name is '暗号化対象（アプリ側 AES-256-GCM。13-1）';
comment on column couple_profiles.email_hash is
  '検索用 HMAC-SHA256。等値一致検索に用いる（5-1／13-1）';
comment on column couple_profiles.memo is
  'planner／admin 向け。列レベル権限で authenticated から select を剥奪し get_couple_memo() 経由で参照する（付録A）';

-- 主連絡先は案件ごとに1行（K03「主連絡先」／6-6-1）
create unique index couple_profiles_primary_uk
  on couple_profiles (case_id) where is_primary_contact;

-- --------------------------------------------------------- case_invitations 案件招待
create table case_invitations (
  id                    uuid        primary key default gen_random_uuid(),
  case_id               uuid        not null references wedding_cases(id) on delete cascade,
  invited_by            uuid        not null references user_profiles(id),
  target_partner_role   varchar(20) not null,
  recipient_email       text,
  recipient_email_hash  text,
  channel               varchar(10) not null default 'email',
  token_hash            text        not null unique,
  purpose               varchar(30) not null,
  expires_at            timestamptz not null,
  used_at               timestamptz,
  revoked_at            timestamptz,
  sent_at               timestamptz,
  use_count             integer     not null default 0,
  max_uses              integer     not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint case_invitations_partner_role_check
    check (target_partner_role in ('groom', 'bride', 'partner_a', 'partner_b')),
  constraint case_invitations_channel_check check (channel in ('line', 'email')),
  constraint case_invitations_purpose_check
    check (purpose in ('initial_registration', 'mypage_access')),
  constraint case_invitations_max_uses_check check (max_uses >= 1),
  constraint case_invitations_use_count_check check (use_count >= 0 and use_count <= max_uses)
);
comment on column case_invitations.token_hash is
  '平文トークンは保存しない（6-3-6）。送信・URL再表示は必ず再発行を伴う（K02）';
comment on column case_invitations.sent_at is '最終送信日時。/send の成功時に記録する';

-- 有効な招待は (case_id, target_partner_role, purpose) ごとに1件（付録A）
create unique index case_invitations_active_uk
  on case_invitations (case_id, target_partner_role, purpose)
  where revoked_at is null and used_at is null;

-- ------------------------------------------------------------ case_guests ゲスト情報
create table case_guests (
  id                  uuid        primary key default gen_random_uuid(),
  case_id             uuid        not null references wedding_cases(id) on delete cascade,
  created_by_user_id  uuid        references user_profiles(id),
  full_name           text        not null,
  kana                text,
  relationship        varchar(50),
  address             text,
  allergy_note        text,
  invitation_status   varchar(20) not null default 'unknown',
  table_name          varchar(50),
  seat_no             varchar(20),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint case_guests_invitation_status_check
    check (invitation_status in ('unknown', 'not_sent', 'sent', 'reply_yes', 'reply_no'))
);

-- ------------------------------------------------------- task_templates 宿題テンプレート
create table task_templates (
  id                 uuid         primary key default gen_random_uuid(),
  venue_id           uuid         not null references venues(id),
  name               varchar(120) not null,
  description        text,
  submission_format  varchar(20)  not null,
  allowed_file_types jsonb        not null default '[]'::jsonb,
  due_offset_days    integer      not null,
  importance         varchar(20)  not null default 'normal',
  default_options    jsonb        not null default '{}'::jsonb,
  is_required        boolean      not null default true,
  active             boolean      not null default true,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),
  constraint task_templates_venue_name_uk unique (venue_id, name),
  constraint task_templates_format_check
    check (submission_format in ('text', 'select', 'file', 'none')),
  constraint task_templates_importance_check
    check (importance in ('normal', 'important', 'critical')),
  constraint task_templates_due_offset_check check (due_offset_days >= 0)
);
comment on column task_templates.submission_format is
  'ファイルの受入種別は allowed_file_types で表現する（csv／image を混在させない。表6-9）';

-- ------------------------------------------- plan_task_templates プラン別宿題テンプレート
create table plan_task_templates (
  id                      uuid        primary key default gen_random_uuid(),
  plan_type_id            uuid        not null references plan_types(id) on delete cascade,
  task_template_id        uuid        not null references task_templates(id) on delete cascade,
  display_order           integer     not null default 0,
  is_required             boolean     not null default true,
  due_offset_days_override integer,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint plan_task_templates_uk unique (plan_type_id, task_template_id),
  constraint plan_task_templates_override_check
    check (due_offset_days_override is null or due_offset_days_override >= 0)
);

-- ------------------------------------------------------------- case_tasks 案件宿題
create table case_tasks (
  id                 uuid         primary key default gen_random_uuid(),
  case_id            uuid         not null references wedding_cases(id) on delete cascade,
  task_template_id   uuid         references task_templates(id) on delete set null,
  title              varchar(120) not null,
  description        text,
  submission_format  varchar(20)  not null default 'text',
  allowed_file_types jsonb        not null default '[]'::jsonb,
  options            jsonb        not null default '{}'::jsonb,
  is_required        boolean      not null default true,
  due_date           date         not null,
  status             varchar(20)  not null default 'not_started',
  importance         varchar(20)  not null default 'normal',
  assigned_to        uuid         references user_profiles(id),
  display_order      integer      not null default 0,
  confirmed_by       uuid         references user_profiles(id),
  confirmed_at       timestamptz,
  last_submitted_at  timestamptz,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),
  constraint case_tasks_format_check
    check (submission_format in ('text', 'select', 'file', 'none')),
  constraint case_tasks_status_check
    check (status in ('not_started', 'submitted', 'needs_fix', 'confirmed', 'waived')),
  constraint case_tasks_importance_check
    check (importance in ('normal', 'important', 'critical'))
);
comment on column case_tasks.submission_format is
  '割当時に task_templates からスナップショットする（6-6-2）。テンプレート変更は既存案件に波及しない';
comment on column case_tasks.importance is
  'important 以上が「重要宿題」（6-8／付録B）';

-- --------------------------------------------------------- storage_files ファイルメタ
create table storage_files (
  id                uuid         primary key default gen_random_uuid(),
  case_id           uuid         not null references wedding_cases(id) on delete cascade,
  uploaded_by       uuid         not null references user_profiles(id),
  bucket            varchar(64)  not null default 'case-files',
  object_path       text         not null unique,
  original_filename varchar(255),
  mime_type         varchar(100),
  file_size_bytes   bigint,
  visibility        varchar(20)  not null default 'case_private',
  created_at        timestamptz  not null default now(),
  constraint storage_files_visibility_check
    check (visibility in ('case_private', 'planner_only', 'system')),
  constraint storage_files_size_check check (file_size_bytes is null or file_size_bytes >= 0)
);

-- ------------------------------------------------------- task_submissions 宿題提出履歴
create table task_submissions (
  id               uuid        primary key default gen_random_uuid(),
  case_task_id     uuid        not null references case_tasks(id) on delete cascade,
  submitted_by     uuid        not null references user_profiles(id),
  submission_type  varchar(20) not null,
  text_value       text,
  selected_value   text,
  content_json     jsonb,
  file_id          uuid        references storage_files(id) on delete set null,
  comment          text,
  review_status    varchar(20) not null default 'draft',
  planner_feedback text,
  submitted_at     timestamptz not null default now(),
  is_latest        boolean     not null default true,
  reviewed_by      uuid        references user_profiles(id),
  reviewed_at      timestamptz,
  -- v1.2: 4値へ統一。提出時点の case_tasks.submission_format を複写する（6-7）
  constraint task_submissions_type_check
    check (submission_type in ('text', 'select', 'file', 'none')),
  constraint task_submissions_review_status_check
    check (review_status in ('draft', 'submitted', 'needs_fix', 'confirmed'))
);
comment on column task_submissions.submission_type is
  '提出時点の case_tasks.submission_format をそのまま複写する（6-7）。none は「確認しました」の1行';
comment on column task_submissions.text_value is '暗号化対象（13-1）';

-- 最新提出は case_task_id ごと1件（5-3）
create unique index task_submissions_latest_uk
  on task_submissions (case_task_id) where is_latest;

-- ---------------------------------------------------- timeline_items タイムライン項目
create table timeline_items (
  id              uuid         primary key default gen_random_uuid(),
  case_id         uuid         not null references wedding_cases(id) on delete cascade,
  related_task_id uuid         references case_tasks(id) on delete cascade,
  title           varchar(120) not null,
  description     text,
  due_date        date         not null,
  phase_name      varchar(50),
  status          varchar(20)  not null default 'planned',
  source          varchar(20)  not null default 'auto',
  display_order   integer      not null default 0,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now(),
  constraint timeline_items_status_check
    check (status in ('planned', 'done', 'overdue', 'skipped')),
  constraint timeline_items_source_check check (source in ('auto', 'manual'))
);

-- assign-tasks の冪等条件（6-6-2）
create unique index timeline_items_task_uk
  on timeline_items (case_id, related_task_id) where related_task_id is not null;
create unique index timeline_items_manual_uk
  on timeline_items (case_id, title, due_date) where related_task_id is null;

-- ------------------------------------------- communication_logs 連絡履歴（自動記録）
create table communication_logs (
  id          uuid        primary key default gen_random_uuid(),
  case_id     uuid        not null references wedding_cases(id) on delete cascade,
  channel     varchar(20) not null,
  direction   varchar(10) not null,
  source      varchar(50) not null,
  summary     text        not null,
  occurred_at timestamptz not null,
  created_by  uuid        references user_profiles(id),
  constraint communication_logs_channel_check check (channel in ('line', 'email', 'in_app')),
  constraint communication_logs_direction_check check (direction in ('inbound', 'outbound'))
);

-- ----------------------------------------------- follow_logs フォロー記録（手入力）
create table follow_logs (
  id          uuid        primary key default gen_random_uuid(),
  case_id     uuid        not null references wedding_cases(id) on delete cascade,
  planner_id  uuid        not null references user_profiles(id),
  method      varchar(20) not null,
  note        text,
  followed_at timestamptz not null,
  created_at  timestamptz not null default now(),
  constraint follow_logs_method_check
    check (method in ('phone', 'line', 'email', 'meeting', 'other'))
);

-- ------------------------------------------------------------- audit_logs 監査ログ
create table audit_logs (
  id            uuid        primary key default gen_random_uuid(),
  actor_user_id uuid        references user_profiles(id),
  action        varchar(50) not null,
  target_type   varchar(50) not null,
  target_id     uuid,
  detail_json   jsonb,
  created_at    timestamptz not null default now()
);
comment on column audit_logs.detail_json is
  '暗号化対象カラムの値は格納しない（変更された列名と変更の有無のみ。5-3）';

-- ---------------------------------------- auth_rate_limits 認証レート制限カウンタ
create table auth_rate_limits (
  id            uuid        primary key default gen_random_uuid(),
  key_type      varchar(30) not null,
  key_hash      text        not null,
  window_start  timestamptz not null,
  attempt_count integer     not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint auth_rate_limits_uk unique (key_type, key_hash, window_start),
  constraint auth_rate_limits_key_type_check
    check (key_type in ('initial_register', 'otp_request', 'otp_verify', 'password_reset'))
);
comment on table auth_rate_limits is
  'Vercel のサーバーレス実行はインスタンスをまたぐため、insert ... on conflict do update returning で原子的に判定する（5-3）';
