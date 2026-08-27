-- BridalHub / にこまる — 案件管理のトランザクション境界
-- 正本: 基本設計書 Version 1.2 5-7／6-3-6／6-6-1／6-6-2。
--
-- 【なぜ security definer 関数へ寄せるのか】
-- Supabase JS はクライアント側からトランザクションを開始できない。
-- 6-6-2 は「各API内では複数テーブルへの書き込みを1つのDBトランザクションにまとめ、
-- 途中失敗時は全体をロールバックする」ことを要求するため、案件登録・宿題一括割当・
-- 招待再発行・案件更新を1回の RPC（＝1トランザクション）に閉じ込める。
-- 「重複削減のため」ではなく「原子性を満たすため」に必須である点は 6-3-4 の共通関数と同じ。
--
-- 【不変条件】
-- security definer は RLS をバイパスするため、6-3-5 表6-4 と同じ考え方で
-- 「呼び出し元の権限検証を関数の入口で必ず行う」ことを不変条件とする。
-- 本ファイルの全関数は先頭で assert_case_staff() を呼び、planner／admin／system_admin かつ
-- 自分が触れてよい案件であることを current_app_user() 由来の情報だけで判定する
-- （引数で渡された利用者IDや式場IDは一切信用しない）。
--
-- 暗号化対象カラム（couple_profiles.full_name／email、case_invitations.recipient_email）は
-- アプリ側で暗号化済みの文字列を受け取る（13-1）。SQL 側では鍵を扱わない。

-- ------------------------------------------------------------ 0. 共通の権限検証
-- 戻り値を jsonb にしているのは、OUT パラメータ名が role 等の予約語と衝突するのを避けるため。
-- p_case_id が NULL のときは「案件に紐付かない操作（案件登録）」として案件スコープ判定を省く。
create or replace function assert_case_staff(p_case_id uuid)
  returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  v_role  text;
  v_venue uuid;
begin
  select u.id, u.role, u.venue_id into v_id, v_role, v_venue from current_app_user() u;

  -- current_app_user() は status='active' を必須条件とする（6-3-4）。
  -- 停止・削除済みの利用者はセッションが生きていてもここで落ちる。
  if v_id is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if v_role not in ('planner', 'admin', 'system_admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_case_id is not null and p_case_id not in (select accessible_case_ids()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object('user_id', v_id, 'role', v_role, 'venue_id', v_venue);
end
$$;

-- ------------------------------------------------------------------ 1. 案件登録
-- 6-6-1／3-3-2 の一連の書き込みを1トランザクションにまとめる。
--   case_code 採番（5-7、UNIQUE 違反時は最大3回まで再採番）
--   → wedding_cases → couple_profiles 2行 → case_invitations 2件 → communication_logs
-- 平文トークンは保存しない（6-3-6）ため、引数として受け取るのはハッシュのみ。
-- 応答の invitations[] とアプリ側が保持する平文トークンを突き合わせて招待URLを組み立てる。
create or replace function create_wedding_case(
  p_wedding_date       date,
  p_wedding_time       time,
  p_plan_type_id       uuid,
  p_contact_channel    text,
  p_guest_count        integer,
  p_venue_room         text,
  p_notes              text,
  p_primary_contact    text,
  p_groom_name_enc     text,
  p_bride_name_enc     text,
  p_contact_email_enc  text,
  p_contact_email_hash text,
  p_invitations        jsonb
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor   jsonb;
  v_user    uuid;
  v_role    text;
  v_venue   uuid;
  v_case_id uuid;
  v_code    text;
  v_attempt integer;
  v_inv     jsonb;
begin
  v_actor := assert_case_staff(null);
  v_user  := (v_actor->>'user_id')::uuid;
  v_role  := v_actor->>'role';
  v_venue := (v_actor->>'venue_id')::uuid;

  -- K03 は planner の画面だが、API は planner／admin を許可する（6-5 表6-6）。
  -- system_admin は式場を持たないため案件を作れない。
  if v_role not in ('planner', 'admin') or v_venue is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_primary_contact not in ('groom', 'bride') then
    raise exception 'invalid primary contact' using errcode = '23514';
  end if;
  -- プラン種別は自式場のものに限る（引数で他式場のIDを渡させない）
  if p_plan_type_id is null or plan_type_venue(p_plan_type_id) is distinct from v_venue then
    raise exception 'plan type not found in venue' using errcode = '23503';
  end if;

  -- 5-7: 連番は式場×年でリセットする。年は「挙式年」を採用し、案件番号だけで挙式シーズンが分かる形にする。
  -- 最終的な一意性は UNIQUE(venue_id, case_code) が担保し、競合時は採番からやり直す。
  v_attempt := 0;
  loop
    v_attempt := v_attempt + 1;
    begin
      v_code := next_case_code(v_venue, extract(year from p_wedding_date)::integer);
      insert into wedding_cases (
        venue_id, plan_type_id, primary_planner_id, case_code, wedding_date, wedding_time,
        contact_channel, guest_count, venue_room, notes
      ) values (
        v_venue, p_plan_type_id, v_user, v_code, p_wedding_date, p_wedding_time,
        coalesce(p_contact_channel, 'email'), coalesce(p_guest_count, 0), p_venue_room, p_notes
      ) returning id into v_case_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 3 then
        raise;
      end if;
    end;
  end loop;

  -- 6-6-1: user_profile_id は NULL で作成し、初回登録時に設定する。
  -- 連絡先メールは「主連絡先」で選んだ側にだけ持たせる（K03 表4-14）。
  insert into couple_profiles (case_id, partner_role, full_name, email, email_hash, is_primary_contact)
  values
    (v_case_id, 'groom', p_groom_name_enc,
     case when p_primary_contact = 'groom' then p_contact_email_enc end,
     case when p_primary_contact = 'groom' then p_contact_email_hash end,
     p_primary_contact = 'groom'),
    (v_case_id, 'bride', p_bride_name_enc,
     case when p_primary_contact = 'bride' then p_contact_email_enc end,
     case when p_primary_contact = 'bride' then p_contact_email_hash end,
     p_primary_contact = 'bride');

  -- 招待は新郎・新婦の2件。主連絡先側にだけ recipient_email を設定する（6-6-1）。
  for v_inv in select * from jsonb_array_elements(p_invitations) loop
    insert into case_invitations (
      case_id, invited_by, target_partner_role, recipient_email, recipient_email_hash,
      channel, token_hash, purpose, expires_at, max_uses
    ) values (
      v_case_id, v_user, v_inv->>'target_partner_role',
      case when v_inv->>'target_partner_role' = p_primary_contact then p_contact_email_enc end,
      case when v_inv->>'target_partner_role' = p_primary_contact then p_contact_email_hash end,
      coalesce(v_inv->>'channel', 'email'), v_inv->>'token_hash',
      coalesce(v_inv->>'purpose', 'initial_registration'),
      (v_inv->>'expires_at')::timestamptz, coalesce((v_inv->>'max_uses')::integer, 1)
    );

    -- 6-6-1「2（URL発行）・3（送信）の各時点で communication_logs に自動記録する」
    insert into communication_logs (case_id, channel, direction, source, summary, occurred_at, created_by)
    values (v_case_id, coalesce(v_inv->>'channel', 'email'), 'outbound', 'invitation.issue',
            '招待URLを発行しました: ' || (v_inv->>'target_partner_role'), now(), v_user);
  end loop;

  perform log_audit('case.create', 'wedding_cases', v_case_id,
                    jsonb_build_object('case_code', v_code));

  return jsonb_build_object(
    'case_id', v_case_id,
    'case_code', v_code,
    'invitations', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', ci.id,
               'target_partner_role', ci.target_partner_role,
               'channel', ci.channel,
               'expires_at', ci.expires_at) order by ci.target_partner_role), '[]'::jsonb)
        from case_invitations ci where ci.case_id = v_case_id));
end
$$;

-- -------------------------------------------------------------- 2. 宿題一括割当
-- 6-6-2: case_tasks と timeline_items を同一トランザクションで作る。
-- 再実行時は未割当のテンプレート分のみ追加し、既存 case_tasks は変更しない（エラーにしない）。
-- timeline_items の冪等性は既存の部分ユニークインデックスに任せ、on conflict do nothing で吸収する。
-- 期限・phase_name はサービス層（schedule.ts）が算出済みの値を受け取る。判定ロジックをSQLへ二重化しない。
create or replace function assign_case_tasks(p_case_id uuid, p_tasks jsonb)
  returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_task    jsonb;
  v_task_id uuid;
  v_added   integer := 0;
begin
  perform assert_case_staff(p_case_id);

  for v_task in select * from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) loop
    -- テンプレート由来の割当のみを扱う。個別追加（task_template_id = NULL）は add_case_task を使う。
    if v_task->>'task_template_id' is null then
      continue;
    end if;
    if exists (select 1 from case_tasks ct
                where ct.case_id = p_case_id
                  and ct.task_template_id = (v_task->>'task_template_id')::uuid) then
      continue;
    end if;

    insert into case_tasks (
      case_id, task_template_id, title, description, submission_format,
      allowed_file_types, options, is_required, due_date, importance, display_order
    ) values (
      p_case_id, (v_task->>'task_template_id')::uuid, v_task->>'title', v_task->>'description',
      coalesce(v_task->>'submission_format', 'text'),
      coalesce(v_task->'allowed_file_types', '[]'::jsonb),
      coalesce(v_task->'options', '{}'::jsonb),
      coalesce((v_task->>'is_required')::boolean, true),
      (v_task->>'due_date')::date,
      coalesce(v_task->>'importance', 'normal'),
      coalesce((v_task->>'display_order')::integer, 0)
    ) returning id into v_task_id;

    insert into timeline_items (
      case_id, related_task_id, title, description, due_date, phase_name, display_order, source
    ) values (
      p_case_id, v_task_id, v_task->>'title', v_task->>'description',
      (v_task->>'due_date')::date, v_task->>'phase_name',
      coalesce((v_task->>'display_order')::integer, 0), 'auto'
    ) on conflict do nothing;

    v_added := v_added + 1;
  end loop;

  return v_added;
end
$$;

-- ------------------------------------------------------- 3. 個別宿題の追加（機能5-5）
-- K02「宿題を追加」。task_template_id は NULL、display_order は既存の最大値+1（4-3 K02）。
create or replace function add_case_task(p_case_id uuid, p_task jsonb)
  returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order   integer;
  v_task_id uuid;
begin
  perform assert_case_staff(p_case_id);
  if not case_is_visible(p_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(max(display_order), -1) + 1 into v_order
    from case_tasks where case_id = p_case_id;

  insert into case_tasks (
    case_id, task_template_id, title, description, submission_format,
    allowed_file_types, options, is_required, due_date, importance, display_order
  ) values (
    p_case_id, null, p_task->>'title', p_task->>'description',
    coalesce(p_task->>'submission_format', 'text'),
    coalesce(p_task->'allowed_file_types', '[]'::jsonb),
    coalesce(p_task->'options', '{}'::jsonb),
    coalesce((p_task->>'is_required')::boolean, true),
    (p_task->>'due_date')::date,
    coalesce(p_task->>'importance', 'normal'),
    v_order
  ) returning id into v_task_id;

  insert into timeline_items (
    case_id, related_task_id, title, description, due_date, phase_name, display_order, source
  ) values (
    p_case_id, v_task_id, p_task->>'title', p_task->>'description',
    (p_task->>'due_date')::date, p_task->>'phase_name', v_order, 'manual'
  ) on conflict do nothing;

  return jsonb_build_object('id', v_task_id, 'display_order', v_order);
end
$$;

-- --------------------------------------------- 4. 個別宿題の変更（期限変更・waived）
-- case_tasks と timeline_items を1トランザクションで揃える（片方だけ古い期限が残らないようにする）。
create or replace function update_case_task(p_case_task_id uuid, p_patch jsonb)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case_id uuid;
begin
  select ct.case_id into v_case_id from case_tasks ct where ct.id = p_case_task_id;
  if v_case_id is null then
    raise exception 'task not found' using errcode = 'PGRST116';
  end if;
  perform assert_case_staff(v_case_id);
  if not case_is_visible(v_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update case_tasks set
    title       = case when jsonb_exists(p_patch, 'title')
                       then p_patch->>'title' else title end,
    description = case when jsonb_exists(p_patch, 'description')
                       then p_patch->>'description' else description end,
    due_date    = case when jsonb_exists(p_patch, 'due_date')
                       then (p_patch->>'due_date')::date else due_date end,
    -- 「対応不要にする」の解除は、提出状況を書き換えないよう waived からのみ not_started へ戻す
    status      = case when jsonb_exists(p_patch, 'waived') and (p_patch->>'waived')::boolean
                       then 'waived'
                       when jsonb_exists(p_patch, 'waived') and not (p_patch->>'waived')::boolean
                            and status = 'waived'
                       then 'not_started'
                       else status end
  where id = p_case_task_id;

  update timeline_items set
    title    = case when jsonb_exists(p_patch, 'title')
                    then p_patch->>'title' else title end,
    due_date = case when jsonb_exists(p_patch, 'due_date')
                    then (p_patch->>'due_date')::date else due_date end,
    phase_name = case when jsonb_exists(p_patch, 'phase_name')
                      then p_patch->>'phase_name' else phase_name end
  where related_task_id = p_case_task_id;
end
$$;

-- --------------------------------------------------------- 5. 招待の発行・再発行
-- 6-3-6: 平文トークンを保存しないため、送信もURL再表示も必ず再発行を伴う。
-- 「既存の有効行に revoked_at を付与 → 新規行を insert」を同一トランザクションで行う。
-- 部分ユニークインデックス case_invitations_active_uk と順序が競合しないよう、失効を先に行う。
create or replace function reissue_case_invitation(
  p_case_id              uuid,
  p_target_partner_role  text,
  p_purpose              text,
  p_token_hash           text,
  p_channel              text,
  p_expires_at           timestamptz,
  p_max_uses             integer,
  p_recipient_email_enc  text,
  p_recipient_email_hash text
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor jsonb;
  v_user  uuid;
  v_id    uuid;
begin
  v_actor := assert_case_staff(p_case_id);
  v_user  := (v_actor->>'user_id')::uuid;
  if not case_is_visible(p_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update case_invitations
     set revoked_at = now()
   where case_id = p_case_id
     and target_partner_role = p_target_partner_role
     and purpose = p_purpose
     and revoked_at is null
     and used_at is null;

  insert into case_invitations (
    case_id, invited_by, target_partner_role, recipient_email, recipient_email_hash,
    channel, token_hash, purpose, expires_at, max_uses
  ) values (
    p_case_id, v_user, p_target_partner_role, p_recipient_email_enc, p_recipient_email_hash,
    p_channel, p_token_hash, p_purpose, p_expires_at, coalesce(p_max_uses, 1)
  ) returning id into v_id;

  insert into communication_logs (case_id, channel, direction, source, summary, occurred_at, created_by)
  values (p_case_id, p_channel, 'outbound', 'invitation.issue',
          '招待URLを再発行しました: ' || p_target_partner_role, now(), v_user);

  return jsonb_build_object('id', v_id, 'expires_at', p_expires_at,
                            'channel', p_channel, 'target_partner_role', p_target_partner_role);
end
$$;

-- ------------------------------------------------------------- 6. 送信結果の記録
-- 平文トークンを保存しないため /send は必ず再発行を伴う（6-3-6）。
-- 再発行と送信記録を別RPCに分けると「送ったのに sent_at が無い」状態が残りうるため、
-- 送信成功後にこの1文で sent_at と連絡履歴を確定させる。
create or replace function mark_invitation_sent(p_invitation_id uuid, p_channel text)
  returns timestamptz
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor   jsonb;
  v_case_id uuid;
  v_sent_at timestamptz;
begin
  select ci.case_id into v_case_id from case_invitations ci where ci.id = p_invitation_id;
  if v_case_id is null then
    raise exception 'invitation not found' using errcode = 'PGRST116';
  end if;
  v_actor := assert_case_staff(v_case_id);

  update case_invitations set sent_at = now()
   where id = p_invitation_id
  returning sent_at into v_sent_at;

  insert into communication_logs (case_id, channel, direction, source, summary, occurred_at, created_by)
  values (v_case_id, p_channel, 'outbound', 'invitation.send',
          '招待URLを送信しました', v_sent_at, (v_actor->>'user_id')::uuid);

  return v_sent_at;
end
$$;

-- ------------------------------------------------------------------- 7. 案件更新
-- K04。挙式日・プラン種別の変更に伴う再計算（6-6-2）を案件本体の更新と同一トランザクションで適用する。
-- 「どの宿題の期限をどう変えるか」「どれを waived にするか」「何を追加するか」は
-- サービス層（schedule.ts の recalculateDueDates / previewPlanChange）が算出し、
-- 画面の差分確認ダイアログでプランナーが承認した結果をそのまま受け取る。
-- SQL 側で再計算しないのは、承認された内容と適用内容を必ず一致させるため。
create or replace function apply_case_update(
  p_case_id         uuid,
  p_patch           jsonb,
  p_profiles        jsonb,
  p_due_changes     jsonb,
  p_waived_task_ids uuid[],
  p_new_tasks       jsonb
) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor    jsonb;
  v_user     uuid;
  v_role     text;
  v_venue    uuid;
  v_primary  text;
  v_change   jsonb;
  v_due_n    integer := 0;
  v_waived_n integer := 0;
  v_added_n  integer := 0;
begin
  v_actor := assert_case_staff(p_case_id);
  v_user  := (v_actor->>'user_id')::uuid;
  v_role  := v_actor->>'role';
  v_venue := (v_actor->>'venue_id')::uuid;

  -- アーカイブ／復元は admin のみ（K05／2-6）。archived の付け外しは他の項目と同時に受け付けない。
  if jsonb_exists(p_patch, 'archived') then
    if v_role not in ('admin', 'system_admin') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if (p_patch->>'archived')::boolean then
      update wedding_cases set status = 'archived', archived_at = now() where id = p_case_id;
      perform log_audit('case.archive', 'wedding_cases', p_case_id, null);
    else
      update wedding_cases set status = 'active', archived_at = null where id = p_case_id;
      perform log_audit('case.restore', 'wedding_cases', p_case_id, null);
    end if;
    return jsonb_build_object('due_changed', 0, 'waived', 0, 'added', 0);
  end if;

  -- 担当プランナーの変更は admin のみ。付け替え先は自式場の planner に限る（4-3 K04）。
  if jsonb_exists(p_patch, 'primary_planner_id') then
    if v_role not in ('admin', 'system_admin') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if not exists (select 1 from user_profiles up
                    where up.id = (p_patch->>'primary_planner_id')::uuid
                      and up.role = 'planner'
                      and up.status = 'active'
                      and (v_role = 'system_admin' or up.venue_id = v_venue)) then
      raise exception 'planner not found in venue' using errcode = '23503';
    end if;
  end if;

  if jsonb_exists(p_patch, 'plan_type_id') then
    if plan_type_venue((p_patch->>'plan_type_id')::uuid)
       is distinct from (select c.venue_id from wedding_cases c where c.id = p_case_id) then
      raise exception 'plan type not found in venue' using errcode = '23503';
    end if;
  end if;

  update wedding_cases set
    wedding_date       = case when jsonb_exists(p_patch, 'wedding_date')
                              then (p_patch->>'wedding_date')::date else wedding_date end,
    wedding_time       = case when jsonb_exists(p_patch, 'wedding_time')
                              then (p_patch->>'wedding_time')::time else wedding_time end,
    plan_type_id       = case when jsonb_exists(p_patch, 'plan_type_id')
                              then (p_patch->>'plan_type_id')::uuid else plan_type_id end,
    contact_channel    = case when jsonb_exists(p_patch, 'contact_channel')
                              then p_patch->>'contact_channel' else contact_channel end,
    guest_count        = case when jsonb_exists(p_patch, 'guest_count')
                              then (p_patch->>'guest_count')::integer else guest_count end,
    venue_room         = case when jsonb_exists(p_patch, 'venue_room')
                              then p_patch->>'venue_room' else venue_room end,
    notes              = case when jsonb_exists(p_patch, 'notes')
                              then p_patch->>'notes' else notes end,
    primary_planner_id = case when jsonb_exists(p_patch, 'primary_planner_id')
                              then (p_patch->>'primary_planner_id')::uuid else primary_planner_id end
  where id = p_case_id;

  -- 新郎新婦氏名・主連絡先（K04 は K03 と同一項目）。
  if p_profiles is not null and p_profiles <> '{}'::jsonb then
    if jsonb_exists(p_profiles, 'groom_name_enc') then
      update couple_profiles set full_name = p_profiles->>'groom_name_enc'
       where case_id = p_case_id and partner_role = 'groom';
    end if;
    if jsonb_exists(p_profiles, 'bride_name_enc') then
      update couple_profiles set full_name = p_profiles->>'bride_name_enc'
       where case_id = p_case_id and partner_role = 'bride';
    end if;

    if jsonb_exists(p_profiles, 'primary_contact') then
      v_primary := p_profiles->>'primary_contact';
      -- 部分ユニークインデックス couple_profiles_primary_uk（case_id 単位で1行）に
      -- 一時的にも違反しないよう、必ず解除 → 設定の2文に分ける。
      update couple_profiles set is_primary_contact = false
       where case_id = p_case_id and partner_role <> v_primary and is_primary_contact;
      update couple_profiles set is_primary_contact = true
       where case_id = p_case_id and partner_role = v_primary and not is_primary_contact;
    end if;

    -- 連絡先メールは主連絡先側にだけ反映する。他方は初回登録で本人のメールが入りうるため触らない（6-6-1）。
    if jsonb_exists(p_profiles, 'contact_email_enc') then
      update couple_profiles
         set email = p_profiles->>'contact_email_enc',
             email_hash = p_profiles->>'contact_email_hash'
       where case_id = p_case_id and is_primary_contact;
    end if;
  end if;

  -- 期限の再計算結果を適用する。未提出（not_started／needs_fix）以外は据え置く（6-6-2）。
  for v_change in select * from jsonb_array_elements(coalesce(p_due_changes, '[]'::jsonb)) loop
    update case_tasks
       set due_date = (v_change->>'due_date')::date
     where id = (v_change->>'id')::uuid
       and case_id = p_case_id
       and status in ('not_started', 'needs_fix');
    if found then
      v_due_n := v_due_n + 1;
      update timeline_items
         set due_date = (v_change->>'due_date')::date,
             phase_name = coalesce(v_change->>'phase_name', phase_name)
       where related_task_id = (v_change->>'id')::uuid;
    end if;
  end loop;

  -- 旧プラン由来かつ not_started の宿題を waived にする（削除はしない。6-6-2）
  if p_waived_task_ids is not null and array_length(p_waived_task_ids, 1) > 0 then
    update case_tasks set status = 'waived'
     where id = any(p_waived_task_ids)
       and case_id = p_case_id
       and status = 'not_started';
    get diagnostics v_waived_n = row_count;
  end if;

  if p_new_tasks is not null and jsonb_array_length(p_new_tasks) > 0 then
    v_added_n := assign_case_tasks(p_case_id, p_new_tasks);
  end if;

  perform log_audit('case.update', 'wedding_cases', p_case_id,
                    jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k),
                                       'due_changed', v_due_n,
                                       'waived', v_waived_n,
                                       'added', v_added_n));

  return jsonb_build_object('due_changed', v_due_n, 'waived', v_waived_n, 'added', v_added_n);
end
$$;

-- ------------------------------------------------------------------------ 権限
-- 20260828000500 の一括 revoke は当時存在した関数にしか効かない。
-- 新規関数は既定で PUBLIC に EXECUTE が付くため、ここで明示的に剥がす（6-3-3 デフォルト全拒否）。
revoke execute on function
  assert_case_staff(uuid),
  create_wedding_case(date, time, uuid, text, integer, text, text, text, text, text, text, text, jsonb),
  assign_case_tasks(uuid, jsonb),
  add_case_task(uuid, jsonb),
  update_case_task(uuid, jsonb),
  reissue_case_invitation(uuid, text, text, text, text, timestamptz, integer, text, text),
  mark_invitation_sent(uuid, text),
  apply_case_update(uuid, jsonb, jsonb, jsonb, uuid[], jsonb)
  from public;

-- assert_case_staff は他関数の内部からのみ呼ぶ（security definer の所有者権限で実行される）。
-- authenticated には付与しない。
grant execute on function
  create_wedding_case(date, time, uuid, text, integer, text, text, text, text, text, text, text, jsonb),
  assign_case_tasks(uuid, jsonb),
  add_case_task(uuid, jsonb),
  update_case_task(uuid, jsonb),
  reissue_case_invitation(uuid, text, text, text, text, timestamptz, integer, text, text),
  mark_invitation_sent(uuid, text),
  apply_case_update(uuid, jsonb, jsonb, jsonb, uuid[], jsonb)
  to authenticated;
