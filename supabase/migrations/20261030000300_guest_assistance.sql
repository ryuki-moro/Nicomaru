-- ゲストの特記事項に「身体的なご事情」を加える（アレルギーと並べて回答する）。
--
-- 足腰が弱い・車いす・妊娠中など、当日の席や動線で配慮が必要な事情を区分で受け取り、
-- 区分にない内容や補足は自由記述で受け取る。区分は座席表で「出入口に近い卓」などへ
-- 割り当てる手がかり（自動タグ）にするため平文の区分コードで持ち、
-- 自由記述は健康に関わる個人情報としてアプリ側で暗号化する（13-1）。
-- アレルギーと同じく、出席の回答でのみ保存する。

alter table case_guests
  add column assistance_needs varchar(20)[] not null default '{}',
  add column assistance_note  text,
  add constraint case_guests_assistance_needs_check
    check (assistance_needs <@ array['mobility', 'wheelchair', 'pregnancy', 'hearing',
                                     'vision', 'other']::varchar(20)[]);

comment on column case_guests.assistance_needs is
  '身体的な事情の区分（mobility=足腰／wheelchair=車いす／pregnancy=妊娠中／hearing=耳／vision=目／other=その他）';
comment on column case_guests.assistance_note is '身体的な事情の補足（暗号化対象、13-1）';

-- p_guests の各要素に assistance_needs（文字列の配列）と assistance_note を加える。
-- それ以外の検証・戻り値は 20261030000100 と同じ。
create or replace function submit_guest_response(
  p_token_hash   text,
  p_attending    boolean,
  p_guest_side   text,
  p_relationship text,
  p_guests       jsonb
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case  uuid;
  v_group uuid := gen_random_uuid();
  v_count integer;
begin
  select f.case_id into v_case
    from case_guest_forms f
    join wedding_cases c on c.id = f.case_id
   where f.token_hash = p_token_hash
     and f.revoked_at is null
     and c.archived_at is null;
  if v_case is null then
    return null;
  end if;

  v_count := coalesce(jsonb_array_length(p_guests), 0);
  -- 欠席の回答に同伴者は付かない。人数の上限は API の入力検証と揃える
  if v_count < 1 or v_count > 10 or (not p_attending and v_count > 1) then
    raise exception '回答の人数が不正です' using errcode = 'BH422';
  end if;

  insert into case_guests (
    case_id, full_name, kana, relationship, allergy_note, invitation_status,
    response_group_id, is_companion, guest_side, age_category, gender, responded_at,
    assistance_needs, assistance_note
  )
  select v_case,
         g.value->>'full_name',
         nullif(g.value->>'kana', ''),
         p_relationship,
         case when p_attending then nullif(g.value->>'allergy_note', '') end,
         case when p_attending then 'reply_yes' else 'reply_no' end,
         v_group,
         g.ordinality > 1,
         p_guest_side,
         g.value->>'age_category',
         g.value->>'gender',
         now(),
         case when p_attending then
           array(select distinct jsonb_array_elements_text(
                   coalesce(g.value->'assistance_needs', '[]'::jsonb)))::varchar(20)[]
         else '{}' end,
         case when p_attending then nullif(g.value->>'assistance_note', '') end
    from jsonb_array_elements(p_guests) with ordinality as g(value, ordinality);

  return v_group;
end
$$;

revoke all on function submit_guest_response(text, boolean, text, text, jsonb)
  from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function submit_guest_response(text, boolean, text, text, jsonb)
      to service_role;
  end if;
end
$$;
