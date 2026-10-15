-- BridalHub / にこまる — 定期処理の登録関数（6-12）
--
-- 【なぜ要るか】
-- 20260828001400 の DO ブロックは、本番（Supabase）では2つの理由で一度も動いていなかった。
--
--   1. pg_cron の有無を to_regproc('cron.schedule') で判定しているが、cron.schedule は
--      2引数版と3引数版の多重定義があり、to_regproc は多重定義の名前に対して NULL を返す。
--      そのため pg_cron が在っても「無い」と判定してスキップする。
--      ローカル（PGlite／素の PostgreSQL）には pg_cron が無いので、この不具合は本番で初めて表面化した。
--
--   2. 接続先URLと内部シークレットを alter database ／ alter role の set で置く手順は、
--      Supabase の postgres が非スーパーユーザー（DBの所有者でもない）ため 42501 で拒否される。
--
-- 値は登録時にジョブ本文へ埋め込まれるだけで、実行時に参照されることはない。
-- そこで、値を引数で受け取る関数にする。手順（Issue #14 の手順10）は SQL Editor で次の1行:
--
--   select register_scheduled_jobs('https://<アプリのURL>', '<INTERNAL_CRON_SECRET>');
--
-- 何度呼んでも同じ状態になる（既存の5件を落としてから入れ直す）。
-- 引数は 20260828001400 と同じ5ジョブ・同じ時刻。二重管理を避けるため、以後の変更はこちらだけを直す。
--
-- 【権限】
-- cron.schedule を呼べるのは postgres（SQL Editor の実行ロール）だけでよい。
-- PostgREST 経由で呼ばれないよう anon／authenticated／service_role から execute を落とす。

create or replace function public.register_scheduled_jobs(
  p_base_url             text,
  p_internal_cron_secret text
) returns integer
language plpgsql
as $$
declare
  v_base   text := rtrim(p_base_url, '/');
  v_secret text := p_internal_cron_secret;
  v_cmd    constant text := $cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object('content-type','application/json',
                                      'x-internal-cron-secret', %L),
        body    := '{}'::jsonb)
    $cmd$;
begin
  -- to_regproc は使わない（上記1）。拡張の有無で判定する。
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron / pg_net が無いため定期処理を登録しません（ローカル検証環境）';
    return 0;
  end if;

  if coalesce(v_base, '') = '' or coalesce(v_secret, '') = '' then
    raise exception 'register_scheduled_jobs: base_url と internal_cron_secret は必須です';
  end if;

  if v_base !~ '^https?://' then
    raise exception 'register_scheduled_jobs: base_url は http(s):// で始めてください: %', v_base;
  end if;

  -- 既存の登録を落としてから入れ直す
  perform cron.unschedule(jobname)
     from cron.job
    where jobname in ('bridalhub_risk_recalculate',
                      'bridalhub_notifications_dispatch',
                      'bridalhub_case_purge',
                      'bridalhub_rate_limit_cleanup',
                      'bridalhub_ai_job_reclaim');

  -- 時刻はすべて UTC。JST では +9 時間になる。
  -- リスク再計算は「日次（深夜）」（6-12）なので JST 03:00 = UTC 18:00。
  perform cron.schedule('bridalhub_risk_recalculate', '0 18 * * *',
    format(v_cmd, v_base || '/api/internal/risk-recalculate', v_secret));

  -- 通知ディスパッチは日次。新郎新婦が朝に受け取れるよう JST 08:00 = UTC 23:00。
  perform cron.schedule('bridalhub_notifications_dispatch', '0 23 * * *',
    format(v_cmd, v_base || '/api/internal/notifications-dispatch', v_secret));

  -- 自動削除は日次。利用の少ない時間帯へ寄せる（JST 04:00 = UTC 19:00）。
  perform cron.schedule('bridalhub_case_purge', '0 19 * * *',
    format(v_cmd, v_base || '/api/internal/case-purge', v_secret));

  perform cron.schedule('bridalhub_rate_limit_cleanup', '30 19 * * *',
    format(v_cmd, v_base || '/api/internal/rate-limit-cleanup', v_secret));

  -- AIジョブの滞留回収は10分ごと（6-12）。ワーカーは常時起動とは限らないため、
  -- 掴まれたまま止まったジョブを戻さないと永久に processing で残る（7-3）。
  perform cron.schedule('bridalhub_ai_job_reclaim', '*/10 * * * *',
    format(v_cmd, v_base || '/api/internal/ai-job-reclaim', v_secret));

  raise notice 'BridalHub の定期処理を5件登録しました（6-12）: %', v_base;
  return 5;
end
$$;

revoke all on function public.register_scheduled_jobs(text, text) from public;
do $$
begin
  -- ロールが在る環境（Supabase）でだけ落とす。素の PostgreSQL / PGlite には無い
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.register_scheduled_jobs(text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.register_scheduled_jobs(text, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.register_scheduled_jobs(text, text) from service_role';
  end if;
end
$$;

comment on function public.register_scheduled_jobs(text, text) is
  '定期処理5件を pg_cron に登録する（6-12）。Issue #14 手順10。引数: アプリの公開URL, INTERNAL_CRON_SECRET';
