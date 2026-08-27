-- BridalHub / にこまる — 宿題ステータスのガード
-- 正本: 基本設計書 Version 1.2 4-3 K02／6-6-2／表6-9。
--
-- 【なぜこのマイグレーションが要るのか】
-- 6-6-2 は「旧プラン由来かつ not_started の宿題を waived とし（削除はしない）」と定めており、
-- 一括経路 apply_case_update（20260828000800）は対象を status='not_started' に限っている。
-- ところが個別編集経路 update_case_task には同じ条件が無く、提出済み・確認済みの宿題にも
-- waived を付けられた。付けたあと解除すると status が not_started へ戻るため、
-- confirmed_by／confirmed_at が残ったまま「確認済みなのに未着手」という行ができ、
-- 提出の確認実績（3-3-4）が画面から消える。ここで両経路の条件を揃える。
--
-- 【なぜ SQLSTATE 23503 で投げるのか】
-- supabase-js の rpc() がアプリへ渡すのは SQLSTATE だけで、raise の message は届かない
-- （src/lib/errors.ts の fromPostgresError は error.code だけを見て写像する）。
-- 業務ルール違反を 422 UNPROCESSABLE として返せる SQLSTATE は同関数の対応表で 23503 のみのため、
-- ここでは 23503 を用いる。画面（TaskSection.tsx）は対象外の状態でボタン自体を出さないので、
-- この例外に到達するのは画面が古いまま操作された場合とAPIを直接叩かれた場合に限られる。
-- raise の message は運用時のログ調査用に残す。

-- 既存の update_case_task（20260828000800_case_functions.sql の 4.）を置き換える。
-- create or replace は既存の EXECUTE 権限を保持するが、意図を明示するため末尾で付け直す。
create or replace function update_case_task(p_case_task_id uuid, p_patch jsonb)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case_id    uuid;
  v_status     text;
  v_has_waived boolean;
  v_waived     boolean;
begin
  -- 状態を読んでから更新するまでの間に提出が入るとガードが素通りするため、行ロックを取る。
  select ct.case_id, ct.status into v_case_id, v_status
    from case_tasks ct where ct.id = p_case_task_id for update;
  if v_case_id is null then
    raise exception 'task not found' using errcode = 'PGRST116';
  end if;
  perform assert_case_staff(v_case_id);
  if not case_is_visible(v_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- jsonb_exists ではなく型で判定する。waived:null を「指定あり」と読むと
  -- (null)::boolean が偽側へ落ち、意図せず not_started へ巻き戻すため。
  -- キーが無いときは jsonb_typeof が NULL を返すので、三値論理を持ち込まないよう畳む。
  v_has_waived := coalesce(jsonb_typeof(p_patch->'waived') = 'boolean', false);
  if v_has_waived then
    v_waived := (p_patch->>'waived')::boolean;

    -- 付与できるのは未着手のみ（6-6-2 の一括経路と同条件）。
    -- 既に waived の行への再付与だけは状態が変わらないので受け入れ、
    -- 画面の二重送信や再試行をエラーにしない。
    if v_waived and v_status not in ('not_started', 'waived') then
      -- BH422 の message はそのまま画面へ出る（src/lib/errors.ts の fromPostgresError）。
      -- 内部IDや status の生値は載せず、プランナーが次にすべきことが分かる文言にする。
      raise exception '提出や確認が済んでいる宿題は「対応不要」にできません。'
                      '取り消す場合は担当プランナーへご相談ください'
        using errcode = 'BH422';
    end if;

    -- 解除は waived からのみ。confirmed／submitted を not_started へ巻き戻さない。
    if not v_waived and v_status <> 'waived' then
      raise exception 'この宿題は「対応不要」ではないため、解除できません'
        using errcode = 'BH422';
    end if;
  end if;

  update case_tasks set
    title       = case when jsonb_exists(p_patch, 'title')
                       then p_patch->>'title' else title end,
    description = case when jsonb_exists(p_patch, 'description')
                       then p_patch->>'description' else description end,
    due_date    = case when jsonb_exists(p_patch, 'due_date')
                       then (p_patch->>'due_date')::date else due_date end,
    status      = case when v_has_waived and v_waived then 'waived'
                       when v_has_waived and not v_waived then 'not_started'
                       else status end
  where id = p_case_task_id;

  -- case_tasks と timeline_items を1トランザクションで揃える（片方だけ古い期限が残らないようにする）。
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

-- 6-3-3「デフォルト全拒否」。置き換えでACLは維持されるが、
-- このファイル単体を読んだときに公開範囲が分かるよう明示する。
revoke execute on function update_case_task(uuid, jsonb) from public;
grant execute on function update_case_task(uuid, jsonb) to authenticated;
