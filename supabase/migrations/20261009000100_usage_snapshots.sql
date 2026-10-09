-- GAP-03: 日次の容量・利用状況。管理画面だけが参照し、集計は内部APIのみ。
create table usage_snapshots (
  measured_on date primary key,
  measured_at timestamptz not null,
  database_bytes bigint not null check (database_bytes >= 0),
  storage_bytes bigint check (storage_bytes >= 0),
  database_limit_bytes bigint check (database_limit_bytes > 0),
  storage_limit_bytes bigint check (storage_limit_bytes > 0),
  venue_count bigint not null,
  case_count bigint not null,
  user_count bigint not null,
  file_count bigint not null,
  notification_count bigint not null,
  notification_failure_count bigint not null
);
alter table usage_snapshots enable row level security;
grant select on usage_snapshots to authenticated;
create policy usage_snapshots_select on usage_snapshots for select using (is_system_admin());

-- Storageのアプリ管理外ファイルも含める。metadataにサイズ欠落があれば未取得とする。
-- pg_database_sizeはプロジェクトDBの物理サイズであり、請求額の見積りではない。
create function collect_usage_snapshot(
  p_database_limit_bytes bigint default null,
  p_storage_limit_bytes bigint default null
) returns usage_snapshots
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz := now();
  v_day date := (v_now at time zone 'Asia/Tokyo')::date;
  v_day_start timestamptz := v_day::timestamp at time zone 'Asia/Tokyo';
  v_storage bigint;
  v_result usage_snapshots;
begin
  if p_database_limit_bytes <= 0 or p_storage_limit_bytes <= 0 then
    raise exception 'capacity limits must be positive' using errcode = '22023';
  end if;
  if to_regclass('storage.objects') is not null then
    execute $sql$
      select case when count(*) filter (where metadata->>'size' is null
                  or metadata->>'size' !~ '^[0-9]{1,18}$') > 0 then null
             else coalesce(sum(case when metadata->>'size' ~ '^[0-9]{1,18}$'
                        then (metadata->>'size')::bigint end), 0)::bigint end
        from storage.objects
    $sql$ into v_storage;
  end if;
  insert into usage_snapshots (
    measured_on, measured_at, database_bytes, storage_bytes,
    database_limit_bytes, storage_limit_bytes, venue_count, case_count, user_count,
    file_count, notification_count, notification_failure_count
  ) values (
    v_day, v_now, pg_database_size(current_database()), v_storage,
    p_database_limit_bytes, p_storage_limit_bytes,
    (select count(*) from venues), (select count(*) from wedding_cases),
    (select count(*) from user_profiles where status <> 'deleted'),
    (select count(*) from storage_files),
    (select count(*) from notifications where created_at >= v_day_start
       and created_at < v_day_start + interval '1 day'),
    (select count(*) from notification_logs where status = 'failure'
       and created_at >= v_day_start and created_at < v_day_start + interval '1 day')
  ) on conflict (measured_on) do update set
    measured_at = excluded.measured_at, database_bytes = excluded.database_bytes,
    storage_bytes = excluded.storage_bytes, database_limit_bytes = excluded.database_limit_bytes,
    storage_limit_bytes = excluded.storage_limit_bytes, venue_count = excluded.venue_count,
    case_count = excluded.case_count, user_count = excluded.user_count,
    file_count = excluded.file_count, notification_count = excluded.notification_count,
    notification_failure_count = excluded.notification_failure_count
  returning * into v_result;
  return v_result;
end
$$;
revoke all on function collect_usage_snapshot(bigint, bigint) from public, anon, authenticated;
grant execute on function collect_usage_snapshot(bigint, bigint) to service_role;
