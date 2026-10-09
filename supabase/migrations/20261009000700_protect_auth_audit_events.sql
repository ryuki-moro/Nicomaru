-- 認証監視が信頼するauth.*は、認証処理の専用RPCだけが作成する。
-- authenticatedに公開された汎用log_auditから任意の認証失敗を偽装させない。
create or replace function log_audit(p_action text, p_target_type text,
                                     p_target_id uuid, p_detail jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_action like 'auth.%' then
    raise exception 'Reserved authentication event' using errcode = '42501';
  end if;
  insert into audit_logs (actor_user_id, action, target_type, target_id, detail_json)
  values ((select u.id from current_app_user() u), p_action, p_target_type, p_target_id, p_detail);
end
$$;
