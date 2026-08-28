-- BridalHub / にこまる — AIジョブ入出力の保持期間（Phase 3、7-4／第13章）
--
-- 正本: 基本設計書 7-4「AIジョブの入出力ログ（ai_jobs）の保存期間・閲覧権限を定める（第13章）」
--       ／5-3 ai_jobs「暗号化対象・短い保持期間」／6-12。
--
-- 【13-1 開発チーム決定】
--   入出力（input_ref のテキスト・output・reviewed_output・error_message）は
--   **完了から30日**で消す。行そのもの（メタ情報）は**作成から90日**で消す。
--
-- 30日と90日を分けたのは目的が違うから。
--   - 入出力は個人情報を含みうる（7-4）。案件終了後180日（6-11）まで持つ理由が無い。
--   - メタ情報（job_type／status／model_name／attempts／prompt_template_id）は
--     プロンプト改善の効果検証に使う（7-6）。消すと「どの版が失敗しやすいか」が追えない。
--
-- 差し戻す場合はこの2つの既定値だけを変える。呼び出し側（案件自動削除の定期処理）は変わらない。

create or replace function purge_ai_job_payloads(
  p_payload_days integer default 30,
  p_row_days     integer default 90
) returns table (payloads_cleared integer, rows_deleted integer)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_cleared integer;
  v_deleted integer;
begin
  -- 先に古い行ごと消す。あとから消す順にすると、
  -- 直前にテキストを消した行をもう一度触ることになる。
  with gone as (
    delete from ai_jobs
     where created_at < now() - make_interval(days => p_row_days)
    returning 1
  )
  select count(*)::integer into v_deleted from gone;

  -- 残す行からは本文だけを落とす。
  -- input_ref は NOT NULL なので空の jsonb に置き換える（参照も含めて消す）。
  -- 未完了（queued／processing）は消さない。処理前に入力を消すと必ず失敗するため、
  -- finished_at を条件にする。
  with cleaned as (
    update ai_jobs
       set input_ref       = '{}'::jsonb,
           output          = null,
           reviewed_output = null,
           error_message   = null,
           updated_at      = now()
     where finished_at is not null
       and finished_at < now() - make_interval(days => p_payload_days)
       and (input_ref <> '{}'::jsonb or output is not null
            or reviewed_output is not null or error_message is not null)
    returning 1
  )
  select count(*)::integer into v_cleared from cleaned;

  return query select v_cleared, v_deleted;
end
$$;

revoke execute on function purge_ai_job_payloads(integer, integer) from public;
-- 定期処理（Service Role）からのみ呼ぶ。画面・利用者には開けない。

-- 保持期間の判定に使う列に索引を張る（6-4 と同じ方針。全表走査を日次で回さない）。
create index if not exists ai_jobs_finished_idx on ai_jobs (finished_at)
  where finished_at is not null;
create index if not exists ai_jobs_created_idx  on ai_jobs (created_at);
