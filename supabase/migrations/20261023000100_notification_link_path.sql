-- 通知は認証情報を含まないマイページ内のパスのみを保持する。
alter table notifications add column link_path text;
alter table notifications add constraint notifications_link_path_check
  check (link_path is null or (length(link_path) <= 512 and link_path ~ '^/mypage(/[A-Za-z0-9_-]+)*$'));
-- default引数で旧6引数呼び出しを維持し、曖昧なoverloadを残さない。
drop function create_notification(uuid, uuid, text, text, text, text);
create or replace function create_notification(
  p_case_id           uuid,
  p_recipient_user_id uuid,
  p_channel           text,
  p_notification_type text,
  p_title             text,
  p_body              text,
  p_link_path         text default null
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role  text;
  v_me    uuid;
  v_venue uuid;
  v_id    uuid;
begin
  select u.id, u.role into v_me, v_role from current_app_user() u;

  if v_role not in ('planner', 'admin', 'system_admin') then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  if p_case_id is null
     or p_case_id not in (select accessible_case_ids())
     or not case_is_visible(p_case_id) then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  select c.venue_id into v_venue from wedding_cases c where c.id = p_case_id;

  -- 宛先は同じ案件に属する利用者に限る。任意の user_profiles.id を渡せてはいけない。
  if not exists (
    select 1 from couple_profiles cp
     where cp.case_id = p_case_id and cp.user_profile_id = p_recipient_user_id
  ) then
    raise exception '宛先が案件に紐付いていません' using errcode = 'BH422';
  end if;

  insert into notifications
    (venue_id, case_id, recipient_user_id, created_by, channel, notification_type, title, body,
     status, link_path)
  values
    (v_venue, p_case_id, p_recipient_user_id, v_me, p_channel, p_notification_type,
     p_title, p_body, 'queued', p_link_path)
  returning id into v_id;

  return v_id;
end
$$;

revoke execute on function create_notification(uuid, uuid, text, text, text, text, text) from public;
grant  execute on function create_notification(uuid, uuid, text, text, text, text, text) to authenticated;
