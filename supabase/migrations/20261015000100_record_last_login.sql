-- 最終アクティビティ（基本設計6-8）のログイン入力をAuthの成功時刻から同期する。
-- APIを経由しないメールリンクも対象。リフレッシュ・失敗・通常の更新では進めない。
create function public.sync_auth_last_login() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.user_profiles
     set last_login_at = new.last_sign_in_at
   where auth_user_id = new.id and status = 'active'
     and (last_login_at is null or last_login_at < new.last_sign_in_at);
  return new;
end
$$;
revoke all on function public.sync_auth_last_login() from public, anon, authenticated;

create trigger sync_auth_last_login
  after update of last_sign_in_at on auth.users
  for each row
  when (new.last_sign_in_at is not null and
        new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function public.sync_auth_last_login();

-- 初回の補完は直接更新を保護するトリガーの作成前に行う。
update public.user_profiles p
   set last_login_at = u.last_sign_in_at
  from auth.users u
 where p.auth_user_id = u.id and p.status = 'active'
   and u.last_sign_in_at is not null
   and (p.last_login_at is null or p.last_login_at < u.last_sign_in_at);

-- 初回登録ではAuthの認証がプロフィール作成より先に終わる場合がある。
-- invited→activeも拾い、クライアントからの任意日時の書き込みは採用しない。
create function public.set_profile_last_login() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_signed_in_at timestamptz;
  v_previous timestamptz;
begin
  if tg_op = 'UPDATE' then
    v_previous := old.last_login_at;
    -- 招待有効化とAuthトリガーからの同期以外では、既知の値を維持する。
    if old.status <> 'invited' and (old.status <> 'active' or pg_trigger_depth() = 1) then
      new.last_login_at := v_previous;
      return new;
    end if;
  end if;
  if new.status = 'active' then
    select last_sign_in_at into v_signed_in_at
      from auth.users where id = new.auth_user_id;
  end if;
  new.last_login_at := greatest(v_previous, v_signed_in_at);
  return new;
end
$$;
revoke all on function public.set_profile_last_login() from public, anon, authenticated;

create trigger set_profile_last_login
  before insert or update of last_login_at, status on public.user_profiles
  for each row execute function public.set_profile_last_login();
