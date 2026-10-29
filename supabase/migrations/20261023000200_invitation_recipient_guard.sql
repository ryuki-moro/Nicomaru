-- 宛先保存と招待発行の双方を案件単位で直列化し、別パートナーとの重複を防ぐ。
create function guard_invitation_recipient() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash text;
  v_role text;
begin
  if tg_table_name = 'couple_profiles' then
    v_hash := new.email_hash;
    v_role := new.partner_role;
  else
    if new.revoked_at is not null or new.used_at is not null
       or new.expires_at <= now() or new.use_count >= new.max_uses then
      return new;
    end if;
    v_hash := new.recipient_email_hash;
    v_role := new.target_partner_role;
  end if;
  if v_hash is null then return new; end if;

  perform 1 from wedding_cases where id = new.case_id for update;
  if exists (
    select 1 from couple_profiles
     where case_id = new.case_id and partner_role <> v_role and email_hash = v_hash
  ) or exists (
    select 1 from case_invitations
     where case_id = new.case_id and target_partner_role <> v_role
       and recipient_email_hash = v_hash and revoked_at is null and used_at is null
       and expires_at > now() and use_count < max_uses
  ) then
    raise exception 'もう一方のパートナーと同じメールアドレスは指定できません'
      using errcode = 'BH422';
  end if;
  return new;
end
$$;

revoke all on function guard_invitation_recipient() from public, anon, authenticated;

create trigger couple_profiles_invitation_recipient_guard
  before insert or update of case_id, partner_role, email_hash on couple_profiles
  for each row execute function guard_invitation_recipient();

create trigger case_invitations_recipient_guard
  before insert or update of case_id, target_partner_role, recipient_email_hash,
    revoked_at, used_at, expires_at, use_count, max_uses on case_invitations
  for each row execute function guard_invitation_recipient();
