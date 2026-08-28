-- BridalHub / にこまる — LINE アカウント連携（Phase 2）
--
-- 正本: 基本設計書 Version 1.2 6-10「LINE連携設計」／機能1-3／4-3 M06。
--
--   「紐付け方式は LINE のアカウント連携（linkToken）方式に確定する。手順は
--     (1) friend（follow）イベントを受信、(2) linkToken を発行して連携用URLを返す、
--     (3) ログイン済みセッションで nonce を突合、(4) user_profiles.line_user_id を保存。
--     M06 の「LINE紐付け」導線はこの nonce 発行画面として実装する。
--     『直近の招待や登録者に当てる』ような推測による紐付けは行わない」
--
--   「受信イベントは webhookEventId を保存して重複配信を捨てる（LINE は再送を行う）」

-- ============================================ 1. 連携用 nonce（(3) の突合に使う）
-- nonce は「この LINE アカウントを、いまログインしているこの利用者に結び付けてよい」という
-- 一度限りの証憑。推測されると他人のアカウントを乗っ取れるため、
-- 招待トークンと同じく**平文を保存せずハッシュで持つ**（6-3-6 と同じ考え方）。
create table line_link_nonces (
  id              uuid        primary key default gen_random_uuid(),
  nonce_hash      text        not null unique,
  user_profile_id uuid        not null references user_profiles(id) on delete cascade,
  /** LINE が発行する linkToken。10分程度で失効するため保持期間も短くてよい */
  link_token      text        not null,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);
comment on table line_link_nonces is
  'LINE アカウント連携の nonce（6-10）。平文は保存せずハッシュで突合する';

create index line_link_nonces_user_idx on line_link_nonces (user_profile_id);
create index line_link_nonces_expires_idx on line_link_nonces (expires_at);

-- 参照・書き込みはサーバー側（Service Role）のみ。
-- 利用者に見せる必要が無く、見えると他人の nonce を狙う足がかりになる。
alter table line_link_nonces enable row level security;
revoke select, insert, update, delete on line_link_nonces from authenticated;

-- ================================== 2. 受信イベントの重複排除（LINE は再送を行う）
create table line_webhook_events (
  event_id    text        primary key,
  event_type  varchar(40) not null,
  received_at timestamptz not null default now()
);
comment on table line_webhook_events is
  'LINE Webhook の重複配信を捨てるための記録（6-10）。event_id の一意性がそのまま冪等性になる';

create index line_webhook_events_received_idx on line_webhook_events (received_at);

alter table line_webhook_events enable row level security;
revoke select, insert, update, delete on line_webhook_events from authenticated;

-- =================================== 3. 連携の確定（(4) user_profiles.line_user_id）
-- Webhook は未ログインの経路なので Service Role で動くが、
-- 「nonce と一致した利用者にだけ結び付ける」条件は DB 側にも置く。
-- API 層のバグで任意の user_profile_id へ結び付けられると、アカウント乗っ取りになる。
create or replace function complete_line_link(p_nonce_hash text, p_line_user_id text)
  returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
begin
  -- 検証と消費を1文で行う。同じ nonce が同時に2回届いても1つしか通らない（6-6-1 と同じ手法）
  update line_link_nonces
     set used_at = now()
   where nonce_hash = p_nonce_hash
     and used_at is null
     and expires_at > now()
  returning user_profile_id into v_user;

  if v_user is null then
    return null;
  end if;

  -- line_user_id は UNIQUE。同じ LINE アカウントを別の利用者へ付け替えるときは
  -- 先に旧側を外す（付け替え自体は運用上ありうる：機種変更・アカウント作り直し）。
  update user_profiles set line_user_id = null
   where line_user_id = p_line_user_id and id <> v_user;

  update user_profiles
     set line_user_id = p_line_user_id, updated_at = now()
   where id = v_user;

  return v_user;
end
$$;

revoke execute on function complete_line_link(text, text) from public;
-- authenticated には付与しない。Webhook（Service Role）からのみ呼ぶ。
