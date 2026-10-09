-- 既存5件に容量集計・監視・監査保持の3件を追加する。
-- SQL Editorの所有者が明示実行する登録関数。migration適用だけではジョブを起動しない。
create or replace function public.register_scheduled_jobs(
  p_base_url text, p_internal_cron_secret text
) returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_base text := rtrim(p_base_url, '/');
  v_job record;
  v_count integer := 0;
  v_cmd constant text := $cmd$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('content-type', 'application/json',
                                    'x-internal-cron-secret', %L),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000)
  $cmd$;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_cron / pg_net がないため登録を省略しました';
    return 0;
  end if;
  if coalesce(v_base, '') !~ '^https?://[^/?#@ ]+(:[0-9]+)?$'
     or coalesce(p_internal_cron_secret, '') = '' then
    raise exception '有効なhttp(s)のアプリOriginと内部secretが必要です';
  end if;

  -- UTC指定。所有者の1トランザクション内で入れ替え、繰り返しても8件に保つ。
  for v_job in select * from (values
    ('risk_recalculate', '0 18 * * *', 'risk-recalculate'),
    ('notifications_dispatch', '0 23 * * *', 'notifications-dispatch'),
    ('case_purge', '0 19 * * *', 'case-purge'),
    ('rate_limit_cleanup', '30 19 * * *', 'rate-limit-cleanup'),
    ('ai_job_reclaim', '*/10 * * * *', 'ai-job-reclaim'),
    ('usage_rollup', '30 19 * * *', 'usage-rollup'),
    ('monitoring', '*/10 * * * *', 'monitoring'),
    ('audit_log_purge', '45 19 * * *', 'audit-log-purge')
  ) as jobs(name, schedule, path) loop
    perform cron.unschedule(jobname) from cron.job where jobname = 'bridalhub_' || v_job.name;
    perform cron.schedule('bridalhub_' || v_job.name, v_job.schedule,
      format(v_cmd, v_base || '/api/internal/' || v_job.path, p_internal_cron_secret));
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;
revoke all on function public.register_scheduled_jobs(text, text) from public, anon, authenticated, service_role;
comment on function public.register_scheduled_jobs(text, text) is
  '所有者のみ実行。定期処理8件を登録。容量JST04:30、監査整理JST04:45、監視10分間隔。';
