-- BridalHub / にこまる — service_role へのテーブル権限（6-3-5 表6-4）
--
-- 【なぜ要るか】
-- service_role は RLS をバイパスするバックエンド用ロールで、
-- 表6-4 に列挙した管理処理（利用者作成・招待検証・定期処理など）でのみ使う。
-- RLS を無視できても、テーブルへの GRANT が無ければ「permission denied」で止まる。
--
-- 20260828000500 は authenticated には明示的に grant しているが、service_role には
-- 与えていなかった。Supabase の「Automatically expose new tables」がONなら
-- 自動で付くが、この設定は**無効を推奨**している（anon にまで権限が漏れるため）。
-- 無効にした環境では service_role の grant が付かず、Auth Admin API を使う処理
-- （scripts/bootstrap-system-admin / /api/admin/users など）が落ちる。
--
-- そこで service_role への grant を明示する。RLS はバイパスするので、
-- ここで DML を与えても「誰がどの行を触れるか」の境界は RLS 側で変わらない
-- （service_role は元々全行を触れる前提のロール）。
--
-- 【ローカル検証環境との両立】
-- 素の PostgreSQL や PGlite には service_role が無いので、
-- ロールが在るときだけ実行する（他の Supabase 依存マイグレーションと同じ作法）。

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant select, insert, update, delete on all tables in schema public to service_role;
    grant usage, select on all sequences in schema public to service_role;
    grant execute on all functions in schema public to service_role;

    -- 以降のマイグレーションで作る表・列にも自動で付くようにする。
    -- 20260828000500 の一括 grant が「実行時点の表にしか効かない」問題を
    -- service_role については default privileges で塞ぐ。
    alter default privileges in schema public
      grant select, insert, update, delete on tables to service_role;
    alter default privileges in schema public
      grant usage, select on sequences to service_role;
    alter default privileges in schema public
      grant execute on functions to service_role;
  end if;
end
$$;
