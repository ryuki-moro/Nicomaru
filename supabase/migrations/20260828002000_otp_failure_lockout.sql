-- BridalHub / にこまる — ワンタイムコードの検証失敗による失効（5-3／6-3-1）
--
-- 正本: 基本設計書 5-3 auth_rate_limits の初期値。
--
--   「ワンタイムコードの有効期限10分、同一宛先への送信は60秒間隔かつ1時間に5回まで、
--     **検証失敗5回で当該コードを失効**、
--     初回登録およびパスワード再設定は同一IPから1時間に10回まで」
--
-- 既存の check_rate_limit は「試行のたびに数える」ため、失効の判定には足りない。
-- 必要なのは次の2つ。
--   (1) 数を増やさずに現在値を見る（検証の前に「もう失効しているか」を判定するため）
--   (2) 成功したら数を消す（打ち間違えたあと正しく入力できた人を次回まで縛らない）
--
-- 失効カウンタの鍵は宛先メールアドレスのみで作る（送信元IPを混ぜない）。
-- IPを混ぜると、攻撃者が接続元を変えるだけでカウンタが別物になり、失効しなくなる。
-- 一方、送信そのもののレート制限（otp_verify）は従来どおり IP＋メールで数える。
-- 「総当たりの発信元を絞る」目的と「コードを失効させる」目的で必要な鍵が違う。

-- key_type の値域を広げる。CHECK に無い値は insert できないので、
-- 関数だけ足しても 23514 で止まる（実際にテストで止まった）。
alter table auth_rate_limits drop constraint auth_rate_limits_key_type_check;
alter table auth_rate_limits add constraint auth_rate_limits_key_type_check
  check (key_type in ('initial_register', 'otp_request', 'otp_verify',
                      'otp_verify_failure', 'password_reset'));

/**
 * 現在値を数えずに見る。
 *
 * 上限に達していなければ true（＝まだ受け付けてよい）。
 * ウィンドウの切り方は check_rate_limit と同一にする。
 * ずれると「増やした窓」と「見た窓」が食い違い、失効が効かない時間帯ができる。
 */
create or replace function peek_rate_limit(
  p_key_type       text,
  p_key_hash       text,
  p_window_seconds integer,
  p_max_attempts   integer
) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  select r.attempt_count into v_count
    from auth_rate_limits r
   where r.key_type = p_key_type
     and r.key_hash = p_key_hash
     and r.window_start = v_window;

  return coalesce(v_count, 0) < p_max_attempts;
end
$$;

revoke execute on function peek_rate_limit(text, text, integer, integer) from public;
-- 呼び出しは Service Role のみ（6-3-5 表6-4 'auth.rate-limit' 行）。

/**
 * 失効カウンタを消す。認証に成功した時点で呼ぶ。
 *
 * 全ウィンドウを消すのは、ウィンドウ境界をまたいで古い行が残ると
 * 次のウィンドウで「見えない失敗回数」が積み上がっているように見えるため。
 */
create or replace function clear_rate_limit(p_key_type text, p_key_hash text)
  returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_deleted integer;
begin
  delete from auth_rate_limits
   where key_type = p_key_type and key_hash = p_key_hash;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

revoke execute on function clear_rate_limit(text, text) from public;
