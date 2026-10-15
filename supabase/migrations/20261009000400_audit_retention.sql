-- 基本設計9-1/13章: 監査ログだけを独立バッチで2暦年保持する。
-- 730日換算せずUTC暦で2年引く。閾値と等しい行は保持する。
create or replace function audit_retention_cutoff(p_now timestamptz)
returns timestamptz language sql immutable set search_path = public, pg_temp as $$
  select ((p_now at time zone 'UTC') - interval '2 years') at time zone 'UTC'
$$;
revoke all on function audit_retention_cutoff(timestamptz) from public, anon, authenticated;

-- 外部から対象ID/時刻/保持年数を渡す入口を設けない。
create or replace function purge_expired_audit_logs()
returns table(deleted_count bigint, cutoff timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cutoff timestamptz := audit_retention_cutoff(now()); v_count bigint;
begin
  delete from audit_logs where created_at < v_cutoff;
  get diagnostics v_count = row_count;
  return query select v_count, v_cutoff;
end
$$;
revoke all on function purge_expired_audit_logs() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function purge_expired_audit_logs() to service_role;
  end if;
end $$;

alter table batch_runs drop constraint batch_runs_job_type_check;
alter table batch_runs add constraint batch_runs_job_type_check
  check (job_type in ('risk_recalculate','notifications_dispatch','ai_job_reclaim',
    'case_purge','health_check','usage_rollup','backup','rate_limit_cleanup','audit_log_purge','monitoring'));
