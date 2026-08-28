-- BridalHub / にこまる — AIジョブキュー（Phase 3、機能9-6）
--
-- 正本: 基本設計書 Version 1.2 7-3「ジョブキュー・処理アーキテクチャ」／7-6／6-3-5 表6-4。
--
-- 【この設計の芯】
--   「受け渡しはプル型（ワーカーからのアウトバウンド接続のみ）とし、
--     ローカルLLMサーバーを外部公開しない」
--   「ジョブ取得は for update skip locked を用いたSQL関数（RPC）経由とし、
--     複数ワーカー時も同一ジョブの二重取得を防ぐ」
--   「ワーカーには Service Role Key を配布せず、ジョブ取得と結果書き込みのみを許す
--     security definer RPC を用意し、ワーカー専用DBロールに EXECUTE を付与する」
--
-- ワーカーは校内または自宅のGPU搭載PC上で動く。つまり**開発チームの管理外に近い場所**に置かれる。
-- そこへ Service Role Key を配ると、鍵が漏れた時点でDB全体が読み書きされる。
-- だから鍵ではなく「2つの操作しかできないロール」を渡す。

-- ============================================================ 1. ワーカー用ロール
-- ログイン権限は Supabase 側で付与する（パスワードはマイグレーションに書かない。12章）。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_worker') then
    create role ai_worker nologin noinherit;
  end if;
end
$$;

grant usage on schema public to ai_worker;
-- テーブルへの直接権限は与えない。触れるのは下の2関数だけ。

-- ==================================================== 2. ジョブ取得（プル型・7-3）
-- for update skip locked により、複数ワーカーが同時に呼んでも同じジョブを掴まない。
-- ワーカーは自分の識別子（ホスト名など）を渡し、locked_by / locked_at / started_at に残す。
create or replace function claim_ai_job(p_worker text, p_job_types text[] default null)
  returns table (
    id uuid, job_type text, venue_id uuid, case_id uuid, related_task_id uuid,
    input_ref jsonb, model_name text, prompt_text text, prompt_template_id uuid, attempts integer
  )
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  -- 1件だけ掴む。まとめて取ると、ワーカーが落ちたときの滞留が増える。
  select j.id into v_id
    from ai_jobs j
   where j.status = 'queued'
     and (p_job_types is null or j.job_type = any(p_job_types))
   order by j.created_at
   for update skip locked
   limit 1;

  if v_id is null then
    return;
  end if;

  -- RETURNS TABLE の出力列（attempts など）と表の列は同名で衝突する。
  -- 代入の右辺は必ず表名で修飾する（修飾しないと 42702 ambiguous になる）。
  update ai_jobs
     set status = 'processing',
         locked_by = p_worker,
         locked_at = now(),
         started_at = coalesce(ai_jobs.started_at, now()),
         attempts = ai_jobs.attempts + 1,
         updated_at = now()
   where ai_jobs.id = v_id;

  -- プロンプトは DB 管理（7-6）。解決順序は venue_id 一致を優先し、
  -- 無ければ venue_id IS NULL の共通テンプレートを使う。
  return query
    -- varchar 列は text へ明示的にキャストする。
    -- RETURNS TABLE の宣言型と1つでも食い違うと
    -- 42804「structure of query does not match function result type」で落ちる。
    select j.id, j.job_type::text, j.venue_id, j.case_id, j.related_task_id,
           j.input_ref, coalesce(t.model_name, j.model_name)::text,
           t.prompt_text::text, t.id, j.attempts
      from ai_jobs j
      left join lateral (
        select p.id, p.prompt_text, p.model_name
          from ai_prompt_templates p
         where p.job_type = j.job_type
           and p.active
           and (p.venue_id = j.venue_id or p.venue_id is null)
         order by (p.venue_id is not null) desc, p.version desc
         limit 1
      ) t on true
     where j.id = v_id;
end
$$;

revoke execute on function claim_ai_job(text, text[]) from public;
grant  execute on function claim_ai_job(text, text[]) to ai_worker;

-- ============================================= 3. 結果の書き込み（ワーカー専用）
-- 出力の形は zod（src/lib/ai/schemas.ts）で検証済みのものが渡ってくる前提だが、
-- DB 側でも「processing の自分のジョブしか書けない」ことは縛る。
-- locked_by を照合するのは、滞留回収で queued へ戻された後に
-- 遅れて戻ってきた古いワーカーが結果を上書きするのを防ぐため。
create or replace function complete_ai_job(
  p_job_id  uuid,
  p_worker  text,
  p_output  jsonb,
  p_error   text default null,
  p_model   text default null
) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_ok boolean;
begin
  update ai_jobs
     set status        = case when p_error is null then 'done' else 'failed' end,
         output        = case when p_error is null then p_output else output end,
         error_message = p_error,
         model_name    = coalesce(p_model, model_name),
         finished_at   = now(),
         locked_by     = null,
         locked_at     = null,
         updated_at    = now()
   where id = p_job_id
     and status = 'processing'
     and locked_by = p_worker
  returning true into v_ok;

  return coalesce(v_ok, false);
end
$$;

revoke execute on function complete_ai_job(uuid, text, jsonb, text, text) from public;
grant  execute on function complete_ai_job(uuid, text, jsonb, text, text) to ai_worker;

-- ================================================ 4. 滞留ジョブの回収（7-3／6-12）
-- 「locked_at が30分を超えた processing のジョブは queued へ戻し attempts を加算する
--   （上限3回で failed）。この回収は定期処理として実行する」
--
-- attempts は claim 側で加算しているので、ここでは上限判定だけを行う。
create or replace function reclaim_stalled_ai_jobs(
  p_stale_minutes integer default 30,
  p_max_attempts  integer default 3
) returns table (requeued integer, failed integer)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_requeued integer;
  v_failed   integer;
begin
  -- 上限に達したものは failed で固定する（6-12「attempts 上限で failed 固定」）
  with gone as (
    update ai_jobs
       set status = 'failed',
           error_message = 'ワーカーからの応答がないまま試行回数の上限に達しました',
           locked_by = null, locked_at = null, finished_at = now(), updated_at = now()
     where status = 'processing'
       and locked_at < now() - make_interval(mins => p_stale_minutes)
       and attempts >= p_max_attempts
    returning 1
  )
  select count(*)::integer into v_failed from gone;

  with back as (
    update ai_jobs
       set status = 'queued', locked_by = null, locked_at = null, updated_at = now()
     where status = 'processing'
       and locked_at < now() - make_interval(mins => p_stale_minutes)
       and attempts < p_max_attempts
    returning 1
  )
  select count(*)::integer into v_requeued from back;

  return query select v_requeued, v_failed;
end
$$;

revoke execute on function reclaim_stalled_ai_jobs(integer, integer) from public;
-- 定期処理（Service Role）からのみ呼ぶ。

-- ================================================== 5. ジョブの投入（planner／admin）
-- 7-3「いずれの経路でも Service Role Key は使用しない（6-3-5）」。
-- ai_jobs_write（付録A）は staff に insert を許すが、
-- venue_id の詐称と job_type の取り違えを防ぐため投入も関数に寄せる。
create or replace function enqueue_ai_job(
  p_case_id         uuid,
  p_job_type        text,
  p_input_ref       jsonb,
  p_related_task_id uuid default null
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_role  text;
  v_venue uuid;
  v_id    uuid;
begin
  select u.role into v_role from current_app_user() u;

  if v_role not in ('planner', 'admin', 'system_admin') then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  if p_case_id is null
     or p_case_id not in (select accessible_case_ids())
     or not case_is_visible(p_case_id) then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  -- venue_id は案件から引く。引数で受け取ると他式場のジョブを作れてしまう。
  select c.venue_id into v_venue from wedding_cases c where c.id = p_case_id;

  insert into ai_jobs (venue_id, case_id, related_task_id, job_type, input_ref, status)
  values (v_venue, p_case_id, p_related_task_id, p_job_type, p_input_ref, 'queued')
  returning id into v_id;

  return v_id;
end
$$;

revoke execute on function enqueue_ai_job(uuid, text, jsonb, uuid) from public;
grant  execute on function enqueue_ai_job(uuid, text, jsonb, uuid) to authenticated;

-- ============================================ 6. 結果の確認・採用（プランナー操作）
-- 7-3「プランナーが結果を確認・採用すると status=confirmed、破棄すると discarded とする」。
-- 7-1 の絶対原則により、採用の操作を経ずに自動で反映されることはない。
create or replace function review_ai_job(p_job_id uuid, p_decision text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_role text;
  v_me   uuid;
  v_case uuid;
  v_ok   boolean;
begin
  select u.id, u.role into v_me, v_role from current_app_user() u;

  if v_role not in ('planner', 'admin', 'system_admin') then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  if p_decision not in ('confirmed', 'discarded') then
    raise exception '確認結果の値が不正です' using errcode = 'BH422';
  end if;

  select j.case_id into v_case from ai_jobs j where j.id = p_job_id;
  if v_case is null or v_case not in (select accessible_case_ids()) then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  -- 完了していないジョブは採用できない（生成前の出力を採用してしまわないように）
  update ai_jobs
     set status = p_decision, confirmed_by = v_me, confirmed_at = now(), updated_at = now()
   where id = p_job_id and status = 'done'
  returning true into v_ok;

  return coalesce(v_ok, false);
end
$$;

revoke execute on function review_ai_job(uuid, text) from public;
grant  execute on function review_ai_job(uuid, text) to authenticated;
