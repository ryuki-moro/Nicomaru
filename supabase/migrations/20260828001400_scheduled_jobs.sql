-- BridalHub / にこまる — 定期処理のスケジュール（6-12、Phase 2）
--
-- 正本: 基本設計書 Version 1.2 6-5-2「内部呼び出し（定期処理）の認証」／6-12 表6-12。
--
--   「定期実行のスケジューラは Vercel Cron ではなく Supabase 側（pg_cron）に一本化する。
--     Vercel Hobby の Cron は実行頻度・登録数の制約が強く実行時刻の保証も弱いため、
--     pg_cron から pg_net 等のHTTP呼び出しで本APIを起動する構成とし、
--     業務ロジックは Next.js のサービス層に置いたまま単体テスト可能性を維持する」
--
--   「Supabase Free はアクセスが無いとプロジェクトが一時停止され、停止すると pg_cron 自体も
--     動かず自分を起こせない。そのため死活監視（定期アクセス）だけは pg_cron 一本化の例外とし、
--     GitHub Actions の schedule から Supabase 外部より API を叩く構成とする」
--
-- pg_cron / pg_net は Supabase では拡張として提供される。
-- ローカル検証用の PostgreSQL や PGlite には存在しないため、
-- 拡張が使えるときだけ登録する（マイグレーションを環境共通に保つ）。
--
-- 【設定が必要な値】
-- APIのベースURLと内部呼び出しシークレットは、Supabase 側のデータベース設定に置く。
--   alter database postgres set app.base_url = 'https://<本番ドメイン>';
--   alter database postgres set app.internal_cron_secret = '<INTERNAL_CRON_SECRET と同じ値>';
-- 値をマイグレーションに直書きしないのは 12章「秘密情報はリポジトリにコミットしない」に従うため。

do $$
declare
  v_base   text;
  v_secret text;
begin
  if to_regproc('cron.schedule') is null or to_regproc('net.http_post') is null then
    raise notice 'pg_cron / pg_net が無いため定期処理の登録をスキップします（ローカル検証環境）';
    return;
  end if;

  v_base   := current_setting('app.base_url', true);
  v_secret := current_setting('app.internal_cron_secret', true);

  if v_base is null or v_secret is null then
    raise notice 'app.base_url / app.internal_cron_secret が未設定のため定期処理を登録しません';
    return;
  end if;

  -- 既存の登録を落としてから入れ直す（マイグレーションを何度流しても同じ状態になるように）
  perform cron.unschedule(jobname)
     from cron.job
    where jobname in ('bridalhub_risk_recalculate',
                      'bridalhub_notifications_dispatch',
                      'bridalhub_case_purge',
                      'bridalhub_rate_limit_cleanup',
                      'bridalhub_ai_job_reclaim');

  -- 時刻はすべて UTC。JST では +9 時間になる。
  -- リスク再計算は「日次（深夜）」（6-12）なので JST 03:00 = UTC 18:00。
  perform cron.schedule(
    'bridalhub_risk_recalculate', '0 18 * * *',
    format($cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object('content-type','application/json',
                                      'x-internal-cron-secret', %L),
        body    := '{}'::jsonb)
    $cmd$, v_base || '/api/internal/risk-recalculate', v_secret));

  -- 通知ディスパッチは日次。新郎新婦が朝に受け取れるよう JST 08:00 = UTC 23:00。
  perform cron.schedule(
    'bridalhub_notifications_dispatch', '0 23 * * *',
    format($cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object('content-type','application/json',
                                      'x-internal-cron-secret', %L),
        body    := '{}'::jsonb)
    $cmd$, v_base || '/api/internal/notifications-dispatch', v_secret));

  -- 自動削除は日次。利用の少ない時間帯へ寄せる（JST 04:00 = UTC 19:00）。
  perform cron.schedule(
    'bridalhub_case_purge', '0 19 * * *',
    format($cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object('content-type','application/json',
                                      'x-internal-cron-secret', %L),
        body    := '{}'::jsonb)
    $cmd$, v_base || '/api/internal/case-purge', v_secret));

  perform cron.schedule(
    'bridalhub_rate_limit_cleanup', '30 19 * * *',
    format($cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object('content-type','application/json',
                                      'x-internal-cron-secret', %L),
        body    := '{}'::jsonb)
    $cmd$, v_base || '/api/internal/rate-limit-cleanup', v_secret));

  -- AIジョブの滞留回収は10分ごと（6-12）。ワーカーは常時起動とは限らないため、
  -- 掴まれたまま止まったジョブを戻さないと永久に processing で残る（7-3）。
  perform cron.schedule(
    'bridalhub_ai_job_reclaim', '*/10 * * * *',
    format($cmd$
      select net.http_post(
        url     := %L,
        headers := jsonb_build_object('content-type','application/json',
                                      'x-internal-cron-secret', %L),
        body    := '{}'::jsonb)
    $cmd$, v_base || '/api/internal/ai-job-reclaim', v_secret));

  raise notice 'BridalHub の定期処理を登録しました（6-12）';
end
$$;
