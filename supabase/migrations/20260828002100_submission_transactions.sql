-- BridalHub / にこまる — 提出と確認を単一トランザクションにする（6-7）
--
-- 正本: 基本設計書 6-7「業務ロジック：提出物確認と提出の冪等性」。
--
-- 6-7 は提出・確認を同一トランザクションで行うことを求めているが、
-- PostgREST 経由の実装では1リクエスト＝1トランザクションになるため、
-- 「旧行の降格 → 新行の insert → case_tasks の更新」が別々のトランザクションに分かれていた。
-- 順序で被害を小さくしてはいたが、確認側には補償できない穴が残っていた。
--
--   task_submissions を confirmed にしたあと case_tasks の更新が落ちると、
--   提出だけが確認済みで宿題は submitted のまま残る。
--   RLS（task_submissions_review_planner の WITH CHECK）が submitted への差し戻しを
--   禁じているため、アプリ側から巻き戻すことができない。
--
-- そこで一連の更新を関数1本にまとめる。関数呼び出しは1トランザクションなので、
-- 途中で失敗すれば全部戻る。
--
-- 【security definer にしない】
-- ここが設計上の要。definer にすると RLS を迂回するので、
-- 「誰がどの案件を触れるか」を関数の中で書き直すことになり、
-- 付録A のポリシーと二重管理になる（片方だけ直して穴が開く典型）。
-- invoker のままなら、中の各文にこれまでと同じポリシーがそのまま効く。
-- RLS では届かない操作（相手の draft の掴み替え・is_latest の降格・
-- couple による case_tasks の状態更新）だけは、
-- 既存の security definer 関数を呼んで通す。関数の中から関数を呼べば
-- 同じトランザクションに乗る。

-- ============================================================ 1. 提出（couple）
create or replace function submit_task_atomic(
  p_case_task_id    uuid,
  p_submission_type text,
  p_text_value      text,
  p_selected_value  text,
  p_file_id         uuid,
  p_comment         text,
  p_draft           boolean
) returns table (submission_id uuid, replaced_file_id uuid)
  language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_me       uuid;
  v_role     text;
  v_task     record;
  v_latest   record;
  v_status   text;
  v_id       uuid;
  v_replaced uuid;
begin
  select u.id, u.role into v_me, v_role from current_app_user() u;

  -- 役割は関数の中でも見る。authenticated へ EXECUTE を出している以上、
  -- 呼び出し側の入口チェックだけに頼らない。
  -- RLS も staff の insert を弾くが、その場合のエラーは
  -- 「提出の状態が変わりました」になり、原因が伝わらない。
  if v_role <> 'couple' then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  -- RLS が効くので、触れない宿題はここで 0 行になる。
  -- 存在有無を漏らさないため、呼び出し側はこれを 404 として扱う（6-5-1）。
  select t.id, t.case_id, t.title, t.status
    into v_task
    from case_tasks t
   where t.id = p_case_task_id;
  if not found then
    return;
  end if;

  -- 「対応不要」は提出の対象外（表6-9）
  if v_task.status = 'waived' then
    raise exception 'この宿題は対応不要になっているため提出できません' using errcode = 'BH422';
  end if;

  -- 最新提出は直読みしない。restrictive な task_submissions_hide_draft が
  -- 相手の draft を隠すため、直読みだと 0 行に見えて部分ユニークに衝突する（6-7）。
  select l.id, l.review_status, l.submitted_by, l.file_id
    into v_latest
    from latest_submission_for_task(p_case_task_id) l;

  -- 提出済みを一時保存へ戻すと、case_tasks は submitted のままで提出だけが
  -- プランナーから見えなくなる（付録A hide_draft）。この遷移は受け付けない。
  if p_draft and v_latest.review_status = 'submitted' then
    raise exception '提出済みの内容は一時保存に戻せません。修正して提出し直してください'
      using errcode = 'BH422';
  end if;

  v_status := case when p_draft then 'draft' else 'submitted' end;

  if v_latest.id is not null and v_latest.review_status in ('draft', 'submitted') then
    -- 未レビュー提出は上書きする（409 で弾かない。6-7）。
    -- 相手の行を上書きするときは先に所有権を移す。
    -- update の WHERE／RETURNING にも select ポリシーが効くため、
    -- 移さないと 0 行更新になる。
    if v_latest.submitted_by <> v_me then
      -- 戻り値は掴んだ行のID（掴めなければ NULL）。boolean ではない。
      if claim_latest_submission(p_case_task_id) is null then
        raise exception '提出の状態が変わりました。画面を開き直してからやり直してください'
          using errcode = 'BH409';
      end if;
    end if;

    update task_submissions s
       set submitted_by    = v_me,
           submission_type = p_submission_type,
           text_value      = p_text_value,
           selected_value  = p_selected_value,
           file_id         = p_file_id,
           comment         = p_comment,
           review_status   = v_status,
           submitted_at    = now(),
           is_latest       = true
     where s.id = v_latest.id
    returning s.id into v_id;

    if v_id is null then
      raise exception '提出の状態が変わりました。画面を開き直してからやり直してください'
          using errcode = 'BH409';
    end if;

    if v_latest.file_id is not null and v_latest.file_id is distinct from p_file_id then
      v_replaced := v_latest.file_id;
    end if;
  else
    -- needs_fix／confirmed からの再提出は新しい行にする。
    -- 部分ユニーク task_submissions_latest_uk があるので、必ず降格を先に済ませる。
    if v_latest.id is not null then
      -- 戻り値は降格した行のID（できなければ NULL）
      if demote_latest_submission(p_case_task_id) is null then
        raise exception '提出の状態が変わりました。画面を開き直してからやり直してください'
          using errcode = 'BH409';
      end if;
    end if;

    insert into task_submissions (
      case_task_id, submitted_by, submission_type, text_value, selected_value,
      file_id, comment, review_status, submitted_at, is_latest
    ) values (
      p_case_task_id, v_me, p_submission_type, p_text_value, p_selected_value,
      p_file_id, p_comment, v_status, now(), true
    ) returning id into v_id;
  end if;

  -- 一時保存では case_tasks を動かさない（4-3 M03／6-7）。
  -- couple には case_tasks の update ポリシーが無いので RPC を通す（付録A）。
  if not p_draft then
    perform submit_task(p_case_task_id, 'submitted');
  end if;

  return query select v_id, v_replaced;
end
$$;

revoke execute on function
  submit_task_atomic(uuid, text, text, text, uuid, text, boolean) from public;
grant execute on function
  submit_task_atomic(uuid, text, text, text, uuid, text, boolean) to authenticated;

-- ======================================================== 2. 確認（planner／admin）
create or replace function review_submission(
  p_submission_id uuid,
  p_decision      text,
  p_comment       text
) returns table (submission_id uuid, case_id uuid, case_task_id uuid, task_title text)
  language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_me     uuid;
  v_role   text;
  v_row    record;
  v_now    timestamptz := now();
  v_id     uuid;
begin
  select u.id, u.role into v_me, v_role from current_app_user() u;

  -- couple が呼んだ場合、RLS が update を 0 行にするため
  -- 「すでに確認済みです」という無関係な 409 になる。原因が分かる形で先に弾く。
  if v_role not in ('planner', 'admin', 'system_admin') then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  if p_decision not in ('confirmed', 'needs_fix') then
    raise exception '確認結果の値が不正です' using errcode = 'BH422';
  end if;

  -- RLS 外の提出は 0 行。呼び出し側は 404 として扱う。
  select s.id, s.case_task_id, s.review_status,
         t.title as task_title, t.case_id, t.status as task_status
    into v_row
    from task_submissions s
    join case_tasks t on t.id = s.case_task_id
   where s.id = p_submission_id;
  if not found then
    return;
  end if;

  -- 一時保存は確認対象ではなく、確認済みの提出への再確認も認めない（6-7）
  if v_row.review_status <> 'submitted' then
    raise exception 'この提出はすでに確認済みか、確認できる状態ではありません'
      using errcode = 'BH409';
  end if;

  -- 提出後に宿題を「対応不要」にした場合、ここで確認すると下の更新が
  -- waived を上書きし、免除が黙って外れる。解除は K02 の明示操作に限る（表6-9）。
  if v_row.task_status = 'waived' then
    raise exception 'この宿題は「対応不要」になっているため、確認の必要はありません'
      using errcode = 'BH422';
  end if;

  -- review_status='submitted' を条件に含めることで、同時確認を 0 行更新＝409 で検出する
  update task_submissions s
     set review_status    = p_decision,
         planner_feedback = p_comment,
         reviewed_by      = v_me,
         reviewed_at      = v_now
   where s.id = p_submission_id
     and s.review_status = 'submitted'
  returning s.id into v_id;

  if v_id is null then
    raise exception 'この提出はすでに確認済みです' using errcode = 'BH409';
  end if;

  -- 宿題の状態は提出の確認状態に揃える（3-3-4）。
  -- needs_fix では confirmed_by／confirmed_at を消す。列の意味は「確認した」であり、
  -- 不備ありに戻った宿題に前回の確認者が残ると D03・監査で誤読される。
  update case_tasks t
     set status       = p_decision,
         confirmed_by = case when p_decision = 'confirmed' then v_me else null end,
         confirmed_at = case when p_decision = 'confirmed' then v_now else null end,
         updated_at   = v_now
   where t.id = v_row.case_task_id;

  return query select v_id, v_row.case_id, v_row.case_task_id, v_row.task_title::text;
end
$$;

revoke execute on function review_submission(uuid, text, text) from public;
grant  execute on function review_submission(uuid, text, text) to authenticated;
