-- 新郎新婦によるゲスト一覧の確認（席次の前段、#179）。
--
-- 席次に入れるのは「出席」かつ「新郎新婦が確認済みにした人」だけにする。
-- 回答の「ご関係」が「その他」などで席を決めにくい場合に新郎新婦が直せるようにし、
-- 席次で使う役割（主賓・乾杯のご発声）と、席次表に載せる肩書きも持てるようにする。
-- ゲストの元の回答（relationship）は上書きせず、直した値は relationship_override に持つ。

alter table case_guests
  add column checked_at            timestamptz,
  add column relationship_override varchar(20),
  add column seat_role             varchar(10),
  add column seat_title            varchar(30),
  add constraint case_guests_relationship_override_check
    check (relationship_override is null
           or relationship_override in ('family', 'relative', 'friend', 'colleague', 'teacher',
                                        'other')),
  add constraint case_guests_seat_role_check
    check (seat_role is null or seat_role in ('chief', 'toast')),
  add constraint case_guests_seat_title_check
    check (seat_title is null or length(btrim(seat_title)) > 0);

comment on column case_guests.checked_at is
  '新郎新婦（または担当プランナー）が確認済みにした日時。NULL は確認待ち。席次に入るのは出席かつ確認済みの人';
comment on column case_guests.relationship_override is
  '新郎新婦が直したご関係。NULL なら回答の relationship を使う';
comment on column case_guests.seat_role is 'chief=主賓／toast=乾杯のご発声';
comment on column case_guests.seat_title is '席次表に載せる肩書き。NULL なら画面側で自動の候補を使う';

-- ------------------------------------------------------------ 確認・修正の保存
-- p_patch に含まれるキーだけを更新する（含まれないキーはそのまま）。
--   checked      boolean   … true で確認済み（出席の回答のみ）、false で確認待ちに戻す
--   relationship text      … 直したご関係。回答と同じ値か NULL を渡すと修正を取り消す
--   seat_role    text|null … 'chief'／'toast'／NULL
--   seat_title   text|null … 肩書き。空文字・NULL で自動の候補に戻す
-- 権限は case_guests と同じく案件に触れられる利用者（新郎新婦・担当プランナー）で、
-- アーカイブ済みの案件は変更しない（set_guest_tags と同じ扱い）。
create or replace function review_case_guest(p_guest_id uuid, p_patch jsonb)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_guest case_guests%rowtype;
  v_rel   text;
begin
  select * into v_guest from case_guests where id = p_guest_id;
  if v_guest.id is null
     or v_guest.case_id not in (select accessible_case_ids())
     or not case_is_visible(v_guest.case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from wedding_cases where id = v_guest.case_id and archived_at is not null) then
    raise exception 'archived' using errcode = '42501';
  end if;

  if p_patch ? 'checked' then
    if (p_patch->>'checked')::boolean then
      if v_guest.invitation_status <> 'reply_yes' then
        raise exception 'ご出席の方だけ確認済みにできます' using errcode = 'BH422';
      end if;
      v_guest.checked_at := coalesce(v_guest.checked_at, now());
    else
      v_guest.checked_at := null;
    end if;
  end if;

  if p_patch ? 'relationship' then
    v_rel := nullif(p_patch->>'relationship', '');
    -- 回答と同じ値に戻したら「直していない」扱いにする
    v_guest.relationship_override :=
      case when v_rel is null or v_rel = v_guest.relationship then null else v_rel end;
  end if;

  if p_patch ? 'seat_role' then
    v_guest.seat_role := nullif(p_patch->>'seat_role', '');
  end if;

  if p_patch ? 'seat_title' then
    v_guest.seat_title := nullif(btrim(coalesce(p_patch->>'seat_title', '')), '');
  end if;

  update case_guests
     set checked_at            = v_guest.checked_at,
         relationship_override = v_guest.relationship_override,
         seat_role             = v_guest.seat_role,
         seat_title            = v_guest.seat_title
   where id = p_guest_id;
end
$$;

revoke all on function review_case_guest(uuid, jsonb) from public, anon;
grant execute on function review_case_guest(uuid, jsonb) to authenticated;
