-- ゲストの出欠回答（新郎新婦が配る共通URL → ゲストが出欠・年齢区分・性別・関係・アレルギーを回答）。
--
-- 回答URLは案件ごとに1本。新郎新婦がLINEグループ等で配るため、プランナー向けの初回登録URL
-- （平文を保存しない 6-3-6）とは異なり、あとから再表示できるよう暗号化して保持する。
-- 回答URLで出来るのは「回答の追加」だけで、既存の回答や案件の情報は読めない。
-- ゲストは未ログインのため、回答の照合と書き込みは submit_guest_response() に閉じ、
-- API は Service Role（表6-4 'guest.rsvp'）でこの関数だけを呼ぶ。

-- ------------------------------------------------------------ case_guests の拡張
-- 1回の回答（本人＋同伴者）を response_group_id で束ねる。relationship は関係区分のコードを入れる。
alter table case_guests
  add column response_group_id uuid,
  add column is_companion      boolean     not null default false,
  add column guest_side        varchar(10),
  add column age_category      varchar(10),
  add column gender            varchar(20),
  add column responded_at      timestamptz,
  add constraint case_guests_guest_side_check
    check (guest_side is null or guest_side in ('groom', 'bride')),
  add constraint case_guests_age_category_check
    check (age_category is null or age_category in ('adult', 'child', 'infant')),
  add constraint case_guests_gender_check
    check (gender is null or gender in ('male', 'female', 'unspecified'));

comment on column case_guests.response_group_id is '同じ回答で登録された本人と同伴者に共通のID';
comment on column case_guests.age_category is 'adult=大人／child=子ども（小学生）／infant=幼児。料理・引出物の手配に使う';

create index case_guests_response_group_idx on case_guests (response_group_id);

-- ------------------------------------------------------- case_guest_forms 回答URL
create table case_guest_forms (
  id                 uuid        primary key default gen_random_uuid(),
  case_id            uuid        not null references wedding_cases(id) on delete cascade,
  token_hash         text        not null,
  -- 新郎新婦が再表示するための暗号文（AES-256-GCM、13-1）。照合は token_hash で行う
  token_enc          text        not null,
  created_by_user_id uuid        references user_profiles(id),
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint case_guest_forms_token_hash_uk unique (token_hash)
);

-- 有効な回答URLは案件ごとに1本
create unique index case_guest_forms_active_uk
  on case_guest_forms (case_id) where revoked_at is null;

create trigger case_guest_forms_updated_at_touch before update on case_guest_forms
  for each row execute function touch_updated_at();

alter table case_guest_forms enable row level security;
-- 参照は案件に触れられる利用者のみ。発行・切り替えは reissue_guest_form() に閉じる
create policy case_guest_forms_select on case_guest_forms
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id));
revoke all on case_guest_forms from anon, authenticated;
grant select on case_guest_forms to authenticated;

-- ------------------------------------------------------------ 回答URLの発行・切り替え
-- 既存の有効URLの失効と新規発行を同一トランザクションで行う（2本同時に有効な瞬間を作らない）。
create or replace function reissue_guest_form(p_case_id uuid, p_token_hash text, p_token_enc text)
  returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
  v_id   uuid;
begin
  select u.id into v_user from current_app_user() u;
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_case_id not in (select accessible_case_ids()) or not case_is_visible(p_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from wedding_cases where id = p_case_id and archived_at is not null) then
    raise exception 'archived' using errcode = '42501';
  end if;

  update case_guest_forms set revoked_at = now()
   where case_id = p_case_id and revoked_at is null;

  insert into case_guest_forms (case_id, token_hash, token_enc, created_by_user_id)
  values (p_case_id, p_token_hash, p_token_enc, v_user)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function reissue_guest_form(uuid, text, text) from public, anon;
grant execute on function reissue_guest_form(uuid, text, text) to authenticated;

-- ------------------------------------------------------------ 回答画面の表示情報
-- 未ログインのゲストに見せるのは、挙式日と新郎新婦の氏名（暗号文のまま返しアプリ側で復号）だけ。
create or replace function peek_guest_form(p_token_hash text)
  returns table (wedding_date date, groom_name_enc text, bride_name_enc text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select c.wedding_date,
         (select cp.full_name from couple_profiles cp
           where cp.case_id = c.id and cp.partner_role = 'groom'),
         (select cp.full_name from couple_profiles cp
           where cp.case_id = c.id and cp.partner_role = 'bride')
    from case_guest_forms f
    join wedding_cases c on c.id = f.case_id
   where f.token_hash = p_token_hash
     and f.revoked_at is null
     and c.archived_at is null
$$;

revoke all on function peek_guest_form(text) from public, anon, authenticated;

-- ------------------------------------------------------------ 回答の登録
-- p_guests は [{full_name, kana, age_category, gender, allergy_note}] で、先頭が回答者本人。
-- 氏名・ふりがな・アレルギーはアプリ側で暗号化済みの値を受け取る（13-1）。
-- 戻り値は response_group_id。URLが無効なら NULL（API は 422 にする）。
create or replace function submit_guest_response(
  p_token_hash   text,
  p_attending    boolean,
  p_guest_side   text,
  p_relationship text,
  p_guests       jsonb
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case  uuid;
  v_group uuid := gen_random_uuid();
  v_count integer;
begin
  select f.case_id into v_case
    from case_guest_forms f
    join wedding_cases c on c.id = f.case_id
   where f.token_hash = p_token_hash
     and f.revoked_at is null
     and c.archived_at is null;
  if v_case is null then
    return null;
  end if;

  v_count := coalesce(jsonb_array_length(p_guests), 0);
  -- 欠席の回答に同伴者は付かない。人数の上限は API の入力検証と揃える
  if v_count < 1 or v_count > 10 or (not p_attending and v_count > 1) then
    raise exception '回答の人数が不正です' using errcode = 'BH422';
  end if;

  insert into case_guests (
    case_id, full_name, kana, relationship, allergy_note, invitation_status,
    response_group_id, is_companion, guest_side, age_category, gender, responded_at
  )
  select v_case,
         g.value->>'full_name',
         nullif(g.value->>'kana', ''),
         p_relationship,
         case when p_attending then nullif(g.value->>'allergy_note', '') end,
         case when p_attending then 'reply_yes' else 'reply_no' end,
         v_group,
         g.ordinality > 1,
         p_guest_side,
         g.value->>'age_category',
         g.value->>'gender',
         now()
    from jsonb_array_elements(p_guests) with ordinality as g(value, ordinality);

  return v_group;
end
$$;

revoke all on function submit_guest_response(text, boolean, text, text, jsonb)
  from public, anon, authenticated;

-- Service Role から呼ぶ2関数と新しい表への権限（20260828002200 と同じ扱い）
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on case_guest_forms to service_role;
    grant execute on function peek_guest_form(text) to service_role;
    grant execute on function submit_guest_response(text, boolean, text, text, jsonb)
      to service_role;
  end if;
end
$$;

-- ------------------------------------------------------------ 回答のレート制限
alter table auth_rate_limits drop constraint auth_rate_limits_key_type_check;
alter table auth_rate_limits add constraint auth_rate_limits_key_type_check
  check (key_type in ('initial_register', 'otp_request', 'otp_verify',
                      'otp_verify_failure', 'password_reset', 'password_login', 'login_failure',
                      'guest_rsvp'));
