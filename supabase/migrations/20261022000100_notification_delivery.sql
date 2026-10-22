-- 旧通知には宿題IDが無いため推測で統合・削除しない。旧失敗と自動通知の未送信分は要確認へ隔離する。
alter table notifications add column task_id uuid references case_tasks(id) on delete set null;
alter table notifications add column event_on date;
alter table notifications add column event_key text;
alter table notifications add column event_hash text;
alter table notifications add constraint notifications_task_event_uk
  unique (case_id, task_id, recipient_user_id, notification_type, event_on);
alter table notifications add constraint notifications_manual_event_uk unique(case_id,recipient_user_id,event_key);

-- API応答が失われた場合も、同じ手動送信要求を新しい通知として増やさない。
create function create_notification_once(p_case_id uuid,p_recipient_user_id uuid,p_channel text,
  p_notification_type text,p_title text,p_body text,p_event_key text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_existing notifications%rowtype;
  v_hash text:=md5(jsonb_build_array(p_channel,p_notification_type,p_title,p_body)::text);
begin
  if coalesce(length(p_event_key),0) not between 1 and 200 then raise exception 'invalid event key'; end if;
  begin
    -- 既存関数で案件・宛先・操作者の権限を先に検証する。
    v_id:=create_notification(p_case_id,p_recipient_user_id,p_channel,p_notification_type,p_title,p_body);
    update notifications set event_key=p_event_key,event_hash=v_hash where id=v_id;
    return v_id;
  exception when unique_violation then
    select * into v_existing from notifications where case_id=p_case_id
      and recipient_user_id=p_recipient_user_id and event_key=p_event_key;
    if not found or v_existing.event_hash is distinct from v_hash then
      raise exception '同じ送信キーの内容が異なります' using errcode='BH409';
    end if;
    return v_existing.id;
  end;
end $$;
revoke all on function create_notification_once(uuid,uuid,text,text,text,text,text) from public,anon;
grant execute on function create_notification_once(uuid,uuid,text,text,text,text,text) to authenticated;

create table notification_deliveries (
  notification_id uuid primary key references notifications(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','processing','retry','sent','cancelled','review')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_token uuid,
  retry_key uuid not null default gen_random_uuid(),
  first_requested_at timestamptz,
  channel text,
  payload jsonb,
  switch_reason text,
  last_result text,
  updated_at timestamptz not null default now()
);
create index notification_deliveries_pending_idx on notification_deliveries(next_attempt_at,notification_id)
  where state in ('pending','processing','retry');
alter table notification_deliveries enable row level security;
revoke all on notification_deliveries from public, anon, authenticated;
grant select (notification_id,state,attempt_count,next_attempt_at,lease_until,last_result,updated_at)
  on notification_deliveries to authenticated;
create policy notification_deliveries_select on notification_deliveries for select
  using (exists (select 1 from notifications n where n.id=notification_id));

insert into notification_deliveries(notification_id,state,last_result)
select n.id,
  case when n.status='sent' or (n.status='read' and (n.channel='in_app' or n.sent_at is not null)) or exists
    (select 1 from notification_logs l where l.notification_id=n.id and l.status='success') then 'sent'
    when n.status in ('cancelled','skipped') then 'cancelled'
    when n.status in ('failed','read') or (n.created_by is null and n.notification_type in ('overdue','due_reminder')) then 'review'
    else 'pending' end,
  case when n.status='failed' or (n.status='read' and n.channel<>'in_app' and n.sent_at is null
    and not exists(select 1 from notification_logs l where l.notification_id=n.id and l.status='success'))
    or (n.status='queued' and n.created_by is null
    and n.notification_type in ('overdue','due_reminder')) then 'legacy_unverified' else null end
from notifications n;

-- 日次生成の完了を記録し、途中失敗は同日中の10分cronで生成から再実行する。
create table notification_generation_runs (
  event_on date primary key,
  completed_at timestamptz,
  blocked_reason text
);
alter table notification_generation_runs enable row level security;
revoke all on notification_generation_runs from public,anon,authenticated;
-- 旧版で生成済みの切替日は、宿題IDを復元できないため自動再生成を止めて照合する。
insert into notification_generation_runs(event_on,blocked_reason)
select (now() at time zone 'Asia/Tokyo')::date,'legacy_day_needs_review'
where exists(select 1 from notifications where created_by is null and task_id is null
  and notification_type in ('overdue','due_reminder')
  and (created_at at time zone 'Asia/Tokyo')::date=(now() at time zone 'Asia/Tokyo')::date);

create function initialize_notification_delivery() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into notification_deliveries(notification_id) values (new.id);
  return new;
end $$;
revoke all on function initialize_notification_delivery() from public,anon,authenticated;
create trigger notification_delivery_created after insert on notifications
  for each row execute function initialize_notification_delivery();

-- 受信者の更新権限は既読化だけ。追加した業務キーや送信本文を改変させない。
revoke update on notifications from authenticated;
grant update (status,read_at) on notifications to authenticated;

create function claim_notification_delivery(p_id uuid, p_email_from text,
  p_available_channels text[] default array['email','line','in_app']::text[])
returns setof notification_deliveries
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  n notifications%rowtype;
  d notification_deliveries%rowtype;
  u user_profiles%rowtype;
  selected_channel text;
  switch_reason text;
  line_limit integer;
begin
  -- 通知行もロックし、既読化との競合・同時ワーカーの送信を直列化する。
  select * into n from notifications where id=p_id for update skip locked;
  if not found then return; end if;
  select * into d from notification_deliveries where notification_id=p_id for update skip locked;
  if not found or d.state not in ('pending','processing','retry') then return; end if;
  if d.state='processing' and d.lease_until>clock_timestamp() then return; end if;
  if d.state<>'processing' and d.next_attempt_at>clock_timestamp() then return; end if;
  -- 両providerの冪等性は24時間。時計差・送信遅延の余白を1時間確保する。
  if d.first_requested_at is not null and
     (d.first_requested_at < clock_timestamp()-interval '23 hours' or d.attempt_count>=8) then
    update notification_deliveries set state='review', last_result='retry_window_expired',
      lease_until=null,claim_token=null,updated_at=now() where notification_id=p_id;
    return;
  end if;
  select * into u from user_profiles where id=n.recipient_user_id;
  if not found or u.status<>'active' or exists
    (select 1 from wedding_cases c where c.id=n.case_id and (c.archived_at is not null or c.status not in ('draft','active')))
    or exists (select 1 from venues v where v.id=n.venue_id and not v.active)
    or (n.case_id is not null and not exists (select 1 from couple_profiles cp
      where cp.case_id=n.case_id and cp.user_profile_id=n.recipient_user_id)) then
    update notification_deliveries set state='cancelled',last_result='recipient_or_case_inactive',
      lease_until=null,claim_token=null,updated_at=now() where notification_id=p_id;
    update notifications set status=case when read_at is null then 'cancelled' else 'read' end where id=p_id;
    return;
  end if;
  if d.payload is null then
    selected_channel:=n.channel;
    if selected_channel='line' then
      if u.line_user_id is null then selected_channel:='email'; switch_reason:='LINE未紐付け';
      elsif n.notification_type not in ('overdue','needs_fix') or n.case_id is null then
        selected_channel:='email'; switch_reason:='LINEは案件の重要通知に限定';
      elsif not ('line'=any(p_available_channels)) then
        update notification_deliveries set next_attempt_at=clock_timestamp()+interval '10 minutes',
          last_result='not_configured',updated_at=now() where notification_id=p_id;
        return;
      elsif not claim_line_quota(n.case_id,n.venue_id) then
        selected_channel:='email'; switch_reason:='LINE送信上限に到達';
      end if;
    end if;
    line_limit:=case n.notification_type when 'overdue' then 80 when 'due_reminder' then 80
      when 'needs_fix' then 140 when 'submission_request' then 100 else 200 end;
    if not (selected_channel=any(p_available_channels)) or (selected_channel='email' and coalesce(p_email_from,'')='') then
      update notification_deliveries set next_attempt_at=clock_timestamp()+interval '10 minutes',
        last_result='not_configured',updated_at=now() where notification_id=p_id;
      return;
    end if;
    d.payload:=jsonb_build_object('to',case when selected_channel='line' then u.line_user_id else u.email end,
      'subject',n.title,'text',case when selected_channel='line' and length(n.body)>line_limit
      then left(n.body,line_limit-1)||'…' else n.body end,'from',p_email_from);
    d.channel:=selected_channel;
    d.switch_reason:=switch_reason;
  end if;
  -- 初回だけでなく、固定要求の再試行中に設定が外れた場合も試行数を消費しない。
  if not (d.channel=any(p_available_channels)) then
    update notification_deliveries set state='retry',next_attempt_at=clock_timestamp()+interval '10 minutes',
      lease_until=null,claim_token=null,last_result=coalesce(last_result,'not_configured'),updated_at=now()
      where notification_id=p_id;
    return;
  end if;
  update notification_deliveries set state='processing',attempt_count=attempt_count+1,
    claim_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',
    first_requested_at=coalesce(first_requested_at,clock_timestamp()),payload=d.payload,
    channel=d.channel,switch_reason=d.switch_reason,updated_at=now()
    where notification_id=p_id returning * into d;
  return next d;
end $$;
revoke all on function claim_notification_delivery(uuid,text,text[]) from public,anon,authenticated;
grant execute on function claim_notification_delivery(uuid,text,text[]) to service_role;

create function finish_notification_delivery(p_id uuid,p_claim_token uuid,p_result text,p_provider_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare d notification_deliveries%rowtype;
begin
  if p_result not in ('accepted','unknown','retryable','rejected','not_configured') then
    raise exception 'invalid delivery result';
  end if;
  -- claimと同じロック順。古いワーカーは新しい送信権の結果を書き換えられない。
  perform 1 from notifications where id=p_id for update;
  select * into d from notification_deliveries where notification_id=p_id for update;
  if not found or d.state<>'processing' or d.claim_token is distinct from p_claim_token then return false; end if;
  if d.channel in ('email','line') then
    insert into notification_logs(notification_id,provider,provider_message_id,response_json,status,attempt_no)
      values(p_id,d.channel,p_provider_id,jsonb_build_object('outcome',p_result,'switchReason',d.switch_reason),
        case when p_result='accepted' then 'success' else 'failure' end,d.attempt_count);
  end if;
  update notification_deliveries set
    state=case when p_result='accepted' then 'sent' when p_result='rejected' then 'review' else 'retry' end,
    last_result=p_result,claim_token=null,lease_until=null,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,60*power(2,d.attempt_count-1)::integer)),
    updated_at=now() where notification_id=p_id;
  update notifications set channel=d.channel,
    status=case when read_at is not null then 'read' when p_result='accepted' then 'sent' else 'failed' end,
    sent_at=case when p_result='accepted' then clock_timestamp() else sent_at end where id=p_id;
  return true;
end $$;
revoke all on function finish_notification_delivery(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function finish_notification_delivery(uuid,uuid,text,text) to service_role;
