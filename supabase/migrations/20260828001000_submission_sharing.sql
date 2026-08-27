-- BridalHub / にこまる — 提出は「案件」単位で共有する（6-7）
--
-- 正本: 基本設計書 Version 1.2 6-7「業務ロジック：提出物確認と提出の冪等性」／2-3／6-6-1／付録A。
--
-- 【何が壊れていたか】
-- 6-7 は「同一 case_task_id に未レビュー（draft／submitted）の提出があれば上書き更新する」と
-- 規定しており、提出者が誰かは条件になっていない。新郎新婦は1つの案件・同じ case_tasks を
-- 共有し（2-3、6-6-1 は両方に招待を発行する）、宿題1件に対して持てる提出も
-- 部分ユニーク task_submissions_latest_uk により1件だけである。
-- ところが付録A の実装は提出を「利用者」単位で書いていたため、次の2点が通常操作で起きた。
--
--   (1) 相手が一時保存（draft）すると、もう一方が二度と提出できない。
--       restrictive な task_submissions_hide_draft が draft 行を submitted_by 本人にしか
--       見せないため、提出ハンドラの「最新提出の取得」が 0 行になる。上書き分岐にも降格分岐にも
--       入らないまま is_latest=true で insert し、task_submissions_latest_uk に衝突して
--       23505 → 409 が恒久化する。
--   (2) 相手が提出済み（submitted・未レビュー）の内容を、もう一方が出し直せない。
--       task_submissions_update_couple の USING が submitted_by 一致を要求するため 0 行更新になる。
--
-- 【直し方】
-- 判定の単位を「利用者」から「案件」へ揃える。
--   - 状態判定に要るメタ情報は latest_submission_for_task() で取る（draft でも案件メンバーなら取れる）。
--   - 上書き直前の所有権移転だけを claim_latest_submission() で行う。
--   - update ポリシーは submitted_by 一致ではなく案件メンバー判定にする。
--   - 再提出で case_tasks.confirmed_by／confirmed_at を消す（submit_task）。
--
-- 【方針の芯】付録A の「一時保存（draft）は本人以外に見せない」は変更しない。
-- draft を隠す目的はプランナーに未完成の内容を見せないこと（6-7／6-8 のリスク算出）であり、
-- その帰結として相手側からも中身は見えない。ここで直すのは「見える／見えない」ではなく
-- 「相手の提出があるせいで自分が提出できない」ことなので、中身は隠したまま
-- 状態判定と所有権移転の2操作だけを security definer 関数へ切り出す
-- （couple に広い権限を開かず1操作ずつ関数化する 20260828000900 と同じ考え方）。

-- ================================================== 1. 最新提出の状態を取得する
-- 提出ハンドラが「上書きするのか、降格して新規行を作るのか」を判定するためだけの関数。
--
-- 返すのは状態判定に要るメタ情報（id／review_status／submitted_by／file_id）に限る。
-- text_value・selected_value・comment は返さない。security definer は RLS を素通りするため、
-- ここで本文を返すと task_submissions_hide_draft を無効化する迂回路になる。
create or replace function latest_submission_for_task(p_case_task_id uuid)
  returns table (id uuid, review_status text, submitted_by uuid, file_id uuid)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
  v_role text;
begin
  select ct.case_id into v_case from case_tasks ct where ct.id = p_case_task_id;
  select u.role    into v_role from current_app_user() u;

  if v_case is null
     or v_case not in (select accessible_case_ids())
     or not case_is_visible(v_case) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 提出は couple の操作。プランナーの確認導線（D02）は task_submissions_select で足りるため、
  -- draft を素通しできるこの関数を staff に開かない（6-7 の「プランナーには表示しない」を保つ）。
  -- 停止・削除された利用者は current_app_user() が0行になり v_role が NULL になるため、
  -- <> ではなく is distinct from で弾く。
  if v_role is distinct from 'couple' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select ts.id, ts.review_status::text, ts.submitted_by, ts.file_id
      from task_submissions ts
     where ts.case_task_id = p_case_task_id
       and ts.is_latest;
end
$$;

revoke execute on function latest_submission_for_task(uuid) from public;
grant  execute on function latest_submission_for_task(uuid) to authenticated;

-- ============================================ 2. 未レビュー提出の所有権を実行者へ移す
-- 上書き（update）の直前にだけ使う。行の中身は触らず submitted_by だけを付け替える。
--
-- 【なぜ update ポリシーの修正だけでは足りないか】
-- PostgreSQL は UPDATE でも、WHERE 句や RETURNING が対象テーブルの列を参照する場合は
-- select ポリシーを併せて評価する。提出ハンドラの上書きは
-- 「where id = ... returning id」なので、restrictive な task_submissions_hide_draft が
-- 相手の draft 行を隠したままだと、update ポリシーを案件単位に広げても 0 行更新になる。
-- 所有権を先に移せば hide_draft の「submitted_by = 本人」を満たすため、
-- draft の中身を誰にも開かずに上書きだけが通る。
--
-- 6-7 は「誰が最後に出したか」を submitted_by で表すので、上書きした側へ移すのが正しい
-- （移さないと、相手が下書きしただけの提出が自分の名前で確定してしまう）。
create or replace function claim_latest_submission(p_case_task_id uuid) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
  v_role text;
  v_me   uuid;
  v_id   uuid;
begin
  select ct.case_id      into v_case      from case_tasks ct where ct.id = p_case_task_id;
  select u.id, u.role    into v_me, v_role from current_app_user() u;

  if v_case is null
     or v_case not in (select accessible_case_ids())
     or not case_is_visible(v_case) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_role is distinct from 'couple' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- レビュー済み（needs_fix／confirmed）は上書きの対象外。
  -- そちらは demote_latest_submission() で降格してから新規行を作る（6-7）。
  update task_submissions
     set submitted_by = v_me
   where case_task_id = p_case_task_id
     and is_latest
     and review_status in ('draft', 'submitted')
  returning id into v_id;

  return v_id;
end
$$;

revoke execute on function claim_latest_submission(uuid) from public;
grant  execute on function claim_latest_submission(uuid) to authenticated;

-- ============================== 3. 未レビュー提出の上書きを「案件メンバー」へ広げる
-- 付録A の task_submissions_update_couple は submitted_by 一致を求めていたが、
-- 6-7 の上書き条件に提出者は含まれない。判定単位を案件へ揃える。
--
-- WITH CHECK にロール条件（u.role='couple'）を必ず含める。permissive ポリシーの WITH CHECK は
-- OR 結合されるため、ここを値域だけにすると couple が本ポリシーの USING で行を掴んだうえで
-- task_submissions_review_planner の WITH CHECK 側を満たしにいける余地を作る
-- （v1.2 で同じ理由により review_planner 側へロール条件を足している）。
--
-- WITH CHECK の submitted_by 一致は残す。これは「誰の提出を上書きできるか」ではなく
-- 「更新後の行を誰の名前にできるか」の条件で、task_submissions_insert_couple と同じ不変条件
-- （提出は必ず実行者の名前で記録する）を update にも課すもの。上書き側は
-- claim_latest_submission() で所有権を受け取ってから書くため、通常導線はこれを満たす。
drop policy if exists task_submissions_update_couple on task_submissions;

create policy task_submissions_update_couple on task_submissions
  for update
  using (
    review_status in ('draft', 'submitted')
    and exists (select 1 from case_tasks ct, current_app_user() u
                 where ct.id = task_submissions.case_task_id
                   and ct.case_id in (select accessible_case_ids())
                   and case_is_visible(ct.case_id)
                   and u.role = 'couple'))
  with check (
    review_status in ('draft', 'submitted')
    and submitted_by = (select u.id from current_app_user() u)
    and exists (select 1 from case_tasks ct, current_app_user() u
                 where ct.id = task_submissions.case_task_id
                   and ct.case_id in (select accessible_case_ids())
                   and case_is_visible(ct.case_id)
                   and u.role = 'couple'));

-- demote_latest_submission()（20260828000900）は当初から case_task 単位で書かれており、
-- 「同一案件のパートナーが提出した行でも降格できる」ことを既に満たしている。
-- 本マイグレーションで揃えたい単位と一致しているため変更しない。

-- ================================ 4. 再提出で前回の確認実績を残さない（submit_task）
-- confirmed の宿題を出し直すと status は submitted へ戻るのに、
-- confirmed_by／confirmed_at が前回の確認者のまま残っていた。
-- 列の意味は「この宿題を確認した」であり、未確認の状態に戻った行へ確認者が残ると
-- D03（案件サマリ）や監査で誤読される。
-- 確認を取り消す側（/api/submissions/{id}/review の needs_fix）は既に同じ2列を消しており、
-- 提出側だけが非対称だったのを揃える（3-3-4）。
--
-- 20260828000400_functions.sql の submit_task を差し替える。
-- create or replace は既存の EXECUTE 権限を保持するが、公開範囲が読み取れるよう末尾で付け直す。
create or replace function submit_task(p_case_task_id uuid, p_status text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
  v_role text;
begin
  select ct.case_id into v_case from case_tasks ct where ct.id = p_case_task_id;
  select u.role   into v_role from current_app_user() u;

  if v_case is null
     or v_case not in (select accessible_case_ids())
     or not case_is_visible(v_case) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_role <> 'couple' or p_status <> 'submitted' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update case_tasks
     set status            = p_status,
         last_submitted_at = now(),
         confirmed_by      = null,
         confirmed_at      = null,
         updated_at        = now()
   where id = p_case_task_id;
end
$$;

revoke execute on function submit_task(uuid, text) from public;
grant  execute on function submit_task(uuid, text) to authenticated;

-- ========================= 5. 置き換えられた添付の削除も案件単位にする（storage_files）
-- 提出が案件単位になると、相手が添付したファイルを引き継いだ再提出が通常フローになる。
-- その再提出で別のファイルを選び直すと旧ファイルは孤児になるが、
-- 20260828000900 の storage_files_delete は uploaded_by 本人（と staff）しか削除できないため、
-- 「相手が上げたファイルを置き換えた」ときだけ 6-7 の孤児削除が 0 行で空振りする。
-- Storage 側の case_files_delete は当初から案件単位なので実体だけが消え、
-- 実体の無いメタ行が残るという中途半端な状態になる。
--
-- 削除できる範囲は「同じ案件の新郎新婦が上げたファイル」に限る。
-- planner がアップロードした資料（表5-16）を couple から消せるようにはしない。
drop policy if exists storage_files_delete on storage_files;

create policy storage_files_delete on storage_files
  for delete using (
    case_id in (select accessible_case_ids()) and case_is_visible(case_id)
    and (uploaded_by = (select u.id from current_app_user() u)
         or exists (select 1 from current_app_user() u
                     where u.role in ('planner', 'admin', 'system_admin'))
         or exists (select 1 from couple_profiles cp
                     where cp.case_id = storage_files.case_id
                       and cp.user_profile_id = storage_files.uploaded_by)));
