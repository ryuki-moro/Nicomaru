-- GAP-04: 管理者が共有するアプリ内アラート。業務通知や外部サービスには送らない。
create table system_alerts (
  alert_key text primary key,
  category text not null check (category in ('batch', 'health', 'ai', 'notification', 'capacity', 'auth')),
  source text not null,
  occurrence_count integer not null default 1,
  affected_count bigint not null,
  first_detected_at timestamptz not null,
  last_detected_at timestamptz not null,
  published_at timestamptz not null,
  resolved_at timestamptz
);
comment on table system_alerts is 'system_admin共通の内部通知。本文・氏名・メール・IP・アカウントハッシュは保存しない';
alter table system_alerts enable row level security;
grant select on system_alerts to authenticated;
create policy system_alerts_select on system_alerts for select using (is_system_admin());

-- SQL全体を1トランザクションとし、並行起動による重複通知も防ぐ。
-- p_nowは隔離DBで境界を固定して検証するための引数。公開クライアントは呼べない。
create function evaluate_system_alerts(p_expected_jobs jsonb, p_now timestamptz default now())
returns table (active_count integer, published_count integer, resolved_count integer)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_candidates jsonb := '[]'::jsonb;
  v_job record;
  v_last batch_runs;
  v_baseline timestamptz;
  v_count bigint;
  v_snapshot usage_snapshots;
  v_alert jsonb;
  v_old system_alerts;
  v_keys text[] := array[]::text[];
  v_day_start timestamptz := (p_now at time zone 'Asia/Tokyo')::date::timestamp at time zone 'Asia/Tokyo';
begin
  if jsonb_typeof(p_expected_jobs) <> 'object' or p_expected_jobs is null or p_now is null then
    raise exception 'invalid monitoring settings' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(60100902);
  active_count := 0; published_count := 0; resolved_count := 0;
  select coalesce(min(started_at), p_now) into v_baseline
    from batch_runs where job_type = 'monitoring';

  -- 未設定/未導入の処理は対象にしない。初回から間隔2倍までは猶予を与える。
  for v_job in select key, value from jsonb_each_text(p_expected_jobs) loop
    if v_job.key not in ('risk_recalculate', 'notifications_dispatch', 'ai_job_reclaim',
       'case_purge', 'health_check', 'usage_rollup', 'backup', 'rate_limit_cleanup', 'monitoring',
       'audit_log_purge') or v_job.value is null or v_job.value !~ '^[0-9]{1,7}$'
       or v_job.value::integer not between 1 and 604800 then
      raise exception 'invalid monitored job' using errcode = '22023';
    end if;
    select * into v_last from batch_runs where job_type = v_job.key and started_at <= p_now
      order by started_at desc, id desc limit 1;
    if v_last.http_status >= 400 then
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
        'key', 'batch_failed:' || v_job.key, 'category', 'batch', 'source', v_job.key, 'count', 1));
    end if;
    if coalesce(v_last.started_at, v_baseline) < p_now - make_interval(secs => v_job.value::integer * 2) then
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
        'key', 'batch_missing:' || v_job.key, 'category', 'batch', 'source', v_job.key, 'count', 1));
    end if;
  end loop;

  -- DB障害時はDB自身に失敗を保存できないため、外部KeepaliveのCI通知を併用する。
  select count(*) into v_count from (
    select http_status from batch_runs where job_type = 'health_check'
      and finished_at is not null and started_at <= p_now
      order by started_at desc, id desc limit 2
  ) h where http_status >= 400;
  if v_count >= 2 then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
      'key', 'health_failed', 'category', 'health', 'source', 'health_check', 'count', v_count));
  end if;

  select count(*) into v_count from ai_jobs where status = 'failed';
  if v_count > 0 then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
      'key', 'ai_failed', 'category', 'ai', 'source', 'ai_jobs', 'count', v_count));
  end if;
  select count(*) into v_count from ai_jobs where status = 'processing'
    and coalesce(locked_at, started_at, created_at) < p_now - interval '30 minutes';
  if v_count > 0 then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
      'key', 'ai_stalled', 'category', 'ai', 'source', 'ai_jobs', 'count', v_count));
  end if;

  select count(*) into v_count from notification_logs where status = 'failure'
    and created_at >= v_day_start and created_at < v_day_start + interval '1 day'
    and created_at <= p_now;
  if v_count >= 5 then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
      'key', 'notification_failures', 'category', 'notification', 'source', 'notification_logs', 'count', v_count));
  end if;

  select * into v_snapshot from usage_snapshots where measured_at <= p_now
    order by measured_at desc limit 1;
  -- 未取得/上限未設定は正常と断定しない。閾値超過とは別の設定確認通知を残す。
  if v_snapshot.measured_at is null or v_snapshot.measured_at < p_now - interval '2 days'
     or v_snapshot.database_limit_bytes is null or v_snapshot.storage_limit_bytes is null
     or v_snapshot.storage_bytes is null then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
      'key', 'capacity_unavailable', 'category', 'capacity', 'source', 'usage_snapshot', 'count', 1));
  end if;
  if v_snapshot.measured_at >= p_now - interval '2 days' then
    if v_snapshot.database_bytes::numeric > v_snapshot.database_limit_bytes::numeric * 0.70 then
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
        'key', 'capacity_database', 'category', 'capacity', 'source', 'database', 'count', v_snapshot.database_bytes));
    end if;
    if v_snapshot.storage_bytes::numeric > v_snapshot.storage_limit_bytes::numeric * 0.70 then
      v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
        'key', 'capacity_storage', 'category', 'capacity', 'source', 'storage', 'count', v_snapshot.storage_bytes));
    end if;
  end if;

  select count(*) into v_count from audit_logs where action = 'auth.login_failures'
    and created_at > p_now - interval '1 hour' and created_at <= p_now;
  if v_count > 0 then
    v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
      'key', 'auth_failures', 'category', 'auth', 'source', 'auth', 'count', v_count));
  end if;

  for v_alert in select value from jsonb_array_elements(v_candidates) loop
    v_keys := array_append(v_keys, v_alert->>'key');
    select * into v_old from system_alerts where alert_key = v_alert->>'key' for update;
    if not found then
      insert into system_alerts (alert_key, category, source, affected_count,
        first_detected_at, last_detected_at, published_at)
      values (v_alert->>'key', v_alert->>'category', v_alert->>'source', (v_alert->>'count')::bigint,
        p_now, p_now, p_now);
      published_count := published_count + 1;
    else
      update system_alerts set
        affected_count = (v_alert->>'count')::bigint, last_detected_at = p_now, resolved_at = null,
        first_detected_at = case when v_old.resolved_at is not null then p_now else first_detected_at end,
        published_at = case when v_old.resolved_at is not null or published_at <= p_now - interval '1 hour'
          then p_now else published_at end,
        occurrence_count = occurrence_count + case when v_old.resolved_at is not null
          or published_at <= p_now - interval '1 hour' then 1 else 0 end
      where alert_key = v_alert->>'key';
      if v_old.resolved_at is not null or v_old.published_at <= p_now - interval '1 hour' then
        published_count := published_count + 1;
      end if;
    end if;
  end loop;
  update system_alerts set resolved_at = p_now where resolved_at is null and not (alert_key = any(v_keys));
  get diagnostics resolved_count = row_count;
  active_count := cardinality(v_keys);
  return next;
end
$$;
revoke all on function evaluate_system_alerts(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function evaluate_system_alerts(jsonb, timestamptz) to service_role;

create index audit_logs_auth_failure_monitor_idx on audit_logs (created_at desc)
  where action = 'auth.login_failures';
create index notification_logs_failure_monitor_idx on notification_logs (created_at desc)
  where status = 'failure';
