-- BridalHub / にこまる — 認証系の security definer 関数
-- 正本: 基本設計書 Version 1.2 6-6-1「初回登録フロー」／6-3-1「認証方式」／6-3-5 表6-4。
--
-- 【なぜ関数にするか】
-- (1) consume_invitation / restore_invitation
--     招待トークンの検証と消費は「単一の UPDATE ... RETURNING」で原子的に行う必要がある（6-6-1）。
--     同一URLへの同時2リクエストでも1つしか通らないことがこの1文だけで担保される。
--     Supabase JS からは任意SQLを実行できないため、SQL文をそのまま持つ関数として公開する。
--     case_invitations は未ログイン状態で照合するため RLS をバイパスする必要があり security definer とする。
--     したがって EXECUTE は authenticated／anon に付与せず、Service Role からのみ呼べるようにする（表6-4）。
--
-- (2) complete_invite
--     初回パスワード設定後に user_profiles.status を 'invited' → 'active' へ遷移させる（6-3-1）。
--     この経路が無いと current_app_user() が0行を返し続け、恒久的にログインできない。
--     RLS の user_profiles_update_self は WITH CHECK で
--       role = (select u.role from current_app_user() u)
--     を要求するが、current_app_user() は status='active' を必須条件とする。
--     更新前の行は status='invited' なので同関数は0行を返し、比較結果が NULL となって
--     WITH CHECK が成立しない（RLS は false と NULL の双方を違反とみなす）。
--     つまり本人のセッションからの直接 UPDATE は構造的に通らない。
--     Service Role へ逃げると 6-3-5 表6-4 の使用範囲外になるため、
--     「自分自身の invited → active だけ」に権限を絞った security definer 関数で解決する。
--     auth.uid() を引数で受け取らず関数内で解決することで、対象行の偽装を防ぐ（log_audit と同じ方針）。

-- ------------------------------------------- 1. 招待トークンの原子的な消費（6-6-1）
-- src/lib/services/invitations.ts の CONSUME_INVITATION_SQL と同一の述語を持つ。
-- purpose を WHERE に含めることで、max_uses>1 が許される mypage_access のトークンを
-- 初回登録へ流用できないようにする（6-3-6）。
create or replace function consume_invitation(p_token_hash text, p_purpose text)
  returns table (id uuid, case_id uuid, target_partner_role text, recipient_email_hash text)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  -- RETURNS TABLE の出力名と列名の衝突を避けるため、すべて別名で修飾する。
  return query
    with consumed as (
      update case_invitations ci
         set used_at    = case when ci.use_count + 1 >= ci.max_uses then now() else ci.used_at end,
             use_count  = ci.use_count + 1,
             updated_at = now()
       where ci.token_hash = p_token_hash
         and ci.purpose    = p_purpose
         and ci.used_at    is null
         and ci.revoked_at is null
         and ci.expires_at > now()
         and ci.use_count  < ci.max_uses
      returning ci.id, ci.case_id, ci.target_partner_role, ci.recipient_email_hash
    )
    select c.id, c.case_id, c.target_partner_role::text, c.recipient_email_hash
      from consumed c;
end
$$;

comment on function consume_invitation(text, text) is
  '招待トークンの検証と消費を単一UPDATEで原子的に行う（6-6-1）。0行なら 422 UNPROCESSABLE。Service Role 専用';

-- --------------------------------------------- 2. 消費の巻き戻し（補償処理。6-6-1）
-- Auth ユーザー作成に失敗した場合、および LINE案内の招待で確認コード検証待ちになった場合に、
-- 同じ招待URLを再利用できるよう used_at／use_count を戻す。自動リトライは行わない。
create or replace function restore_invitation(p_invitation_id uuid) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  update case_invitations
     set used_at    = null,
         use_count  = greatest(use_count - 1, 0),
         updated_at = now()
   where id = p_invitation_id
$$;

comment on function restore_invitation(uuid) is
  '初回登録の補償処理（6-6-1）。Service Role 専用';

-- ------------------------------- 3. 初回パスワード設定の完了（invited → active。6-3-1）
-- 対象は本人（auth.uid() 一致行）かつ status='invited' かつパスワードを持つロールに限る。
-- couple はパスワードを設定しないため本関数の対象外（13-1）。
create or replace function complete_invite() returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_role   text;
begin
  select up.status, up.role into v_status, v_role
    from user_profiles up
   where up.auth_user_id = auth.uid();

  if v_status is null then
    return 'not_found';
  end if;

  -- 二重呼び出しは正常系として扱う（画面のリトライで 500 にしない）
  if v_status = 'active' then
    return 'already_active';
  end if;

  if v_status <> 'invited' or v_role not in ('planner', 'admin', 'system_admin') then
    return 'not_allowed';
  end if;

  update user_profiles
     set status = 'active'
   where auth_user_id = auth.uid()
     and status = 'invited';

  return 'activated';
end
$$;

comment on function complete_invite() is
  '初回パスワード設定の完了を受けて自分自身を invited → active にする（6-3-1）。Service Role は使用しない';

-- ------------------------------------------------------------------ 4. 実行権限
-- 本マイグレーション以降に作成した関数は PUBLIC に EXECUTE が既定付与されるため、明示的に剥奪する。
revoke execute on function consume_invitation(text, text) from public;
revoke execute on function restore_invitation(uuid)       from public;
revoke execute on function complete_invite()              from public;

do $$
begin
  -- complete_invite だけは本人のセッション（authenticated）から呼ぶ（6-3-5 表6-4 の「使用しない」行）
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function complete_invite() to authenticated';
  end if;

  -- 招待トークンの消費・巻き戻しは Service Role 専用（表6-4 /api/auth/initial-register 行）
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function consume_invitation(text, text) to service_role';
    execute 'grant execute on function restore_invitation(uuid) to service_role';
    execute 'grant execute on function complete_invite() to service_role';
  end if;
end
$$;
