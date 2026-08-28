-- BridalHub / にこまる — AI補助のコア機能を画面へ出すための追補（Phase 3、機能9-1〜9-5）
--
-- 正本: 基本設計書 7-1／7-2／7-3。
--
-- 20260828001600 でジョブキューの骨格（投入・取得・書き込み・回収・採用）は済んでいる。
-- ここで足すのは、画面から使うために足りていなかった3点。
--
--   (1) ワーカーの死活。7-3 (4)「7-1 の『利用不可』表示は、最終ポーリングから
--       10分以上経過したことを判定条件とする」。判定材料が無かったので心拍を持たせる。
--   (2) プランナーによる出力の修正。7-2「9-1：分類結果は『AIによる分類（要確認）』として
--       表示し、プランナーが修正できる」。修正結果の置き場所が無かった。
--   (3) 提出を契機とするジョブ投入。7-3「提出・打ち合わせ記録登録を契機とするジョブは
--       couple／planner の操作APIのサーバー側処理から内部呼び出しで投入し、
--       クライアントから /api/ai/jobs を直接呼ばせない」。
--       enqueue_ai_job() は staff 限定なので、couple の提出からは呼べない。

-- ============================================================ 1. ワーカーの心拍
-- ジョブの有無に関わらずポーリングのたびに更新する。
-- ai_jobs.locked_at では代用できない。ジョブが1件も無い期間は locked_at が動かず、
-- 「暇だっただけのワーカー」と「落ちているワーカー」が区別できないため。
create table ai_worker_heartbeats (
  worker_name  varchar(120) primary key,
  model_name   varchar(80),
  last_seen_at timestamptz  not null default now()
);
comment on table ai_worker_heartbeats is
  'ローカルLLMワーカーの死活（7-3）。「利用不可」表示の判定材料';

-- RLS を有効にし、ポリシーは作らない（＝誰にも直接は見せない）。
-- authenticated への grant も行わない。20260828000500 の一括付与は実行時点の表にしか
-- 効かないため、何もしなければ既定で権限ゼロになる。参照は下の ai_assist_status() だけを通す。
alter table ai_worker_heartbeats enable row level security;

/**
 * ワーカーからの心拍。ワーカー専用ロールが呼ぶ。
 * 心拍の更新以外は何もできないので、ここから他の表へ波及することはない。
 */
create or replace function ai_worker_ping(p_worker text, p_model text default null)
  returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  insert into ai_worker_heartbeats (worker_name, model_name, last_seen_at)
  values (p_worker, p_model, now())
  on conflict (worker_name) do update
    set last_seen_at = now(),
        model_name   = coalesce(excluded.model_name, ai_worker_heartbeats.model_name);
$$;

revoke execute on function ai_worker_ping(text, text) from public;
grant  execute on function ai_worker_ping(text, text) to ai_worker;

/**
 * AI補助が使える状態か（7-1「LLMサーバー停止時は該当機能を『利用不可』と表示し、
 * 手動運用にフォールバックする」／7-3 (4) の10分）。
 *
 * 返すのは可否と最終心拍だけ。ワーカー名やモデル名は式場の利用者に見せる情報ではない。
 */
create or replace function ai_assist_status()
  returns table (available boolean, last_seen_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(max(h.last_seen_at) > now() - interval '10 minutes', false),
         max(h.last_seen_at)
    from ai_worker_heartbeats h;
$$;

revoke execute on function ai_assist_status() from public;
grant  execute on function ai_assist_status() to authenticated;

-- ================================================ 2. プランナーによる出力の修正
-- 7-2 の 9-1「プランナーが修正できる」。
--
-- output（AIの生出力）は書き換えない。7-6 が prompt_template_id を
-- 「プロンプト改善の効果検証に用いる」と定めており、
-- AIが何を出したかを潰すと、その検証ができなくなるため。
-- 採用された内容は reviewed_output に分けて持つ。画面は
-- coalesce(reviewed_output, output) を表示する。
alter table ai_jobs add column if not exists reviewed_output jsonb;
comment on column ai_jobs.reviewed_output is
  'プランナーが修正して採用した出力（7-2 の 9-1）。NULL なら output をそのまま採用した';

-- review_ai_job は引数を増やす。既定値つきの引数を足すだけだと
-- 2引数の呼び出しが多重定義で曖昧（42725）になるため、いったん落として作り直す。
drop function if exists review_ai_job(uuid, text);

create or replace function review_ai_job(
  p_job_id   uuid,
  p_decision text,
  p_output   jsonb default null
) returns boolean
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

  -- 完了していないジョブは採用できない（生成前の出力を採用してしまわないように）。
  -- 修正内容と採用の記録が食い違わないよう、同じ1文で書く。
  update ai_jobs
     set status          = p_decision,
         reviewed_output = case when p_decision = 'confirmed' then p_output else null end,
         confirmed_by    = v_me,
         confirmed_at    = now(),
         updated_at      = now()
   where id = p_job_id and status = 'done'
  returning true into v_ok;

  return coalesce(v_ok, false);
end
$$;

revoke execute on function review_ai_job(uuid, text, jsonb) from public;
grant  execute on function review_ai_job(uuid, text, jsonb) to authenticated;

-- ======================================== 3. 提出を契機とするジョブ投入（7-3）
-- enqueue_ai_job() は staff 限定なので、couple の提出処理からは呼べない。
-- かといって couple に enqueue_ai_job() を開くと、job_type も case_id も自由に選べてしまう。
--
-- そこで「宿題の提出に伴って発生する2種別だけ」を、宿題から案件を引く形で投入する関数を分ける。
-- 呼び出し元は /api/tasks/{taskId}/submit のサーバー側処理（7-3 の内部呼び出し）。
create or replace function enqueue_submission_ai_job(
  p_case_task_id uuid,
  p_job_type     text,
  p_input_ref    jsonb
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_case  uuid;
  v_venue uuid;
  v_id    uuid;
begin
  -- 提出を契機に発生しうるのはこの2つだけ（7-2 の 9-1／9-4）。
  if p_job_type not in ('classification', 'defect_check') then
    raise exception 'この種別は提出からは投入できません' using errcode = 'BH422';
  end if;

  select t.case_id into v_case from case_tasks t where t.id = p_case_task_id;
  if v_case is null
     or v_case not in (select accessible_case_ids())
     or not case_is_visible(v_case) then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  -- 同じ宿題・同じ種別で未処理のジョブが残っているなら積み増さない。
  -- 一時保存と提出を往復されるとジョブだけが増え、ワーカーの処理時間を食う。
  select j.id into v_id
    from ai_jobs j
   where j.related_task_id = p_case_task_id
     and j.job_type = p_job_type
     and j.status in ('queued', 'processing')
   order by j.created_at desc
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  select c.venue_id into v_venue from wedding_cases c where c.id = v_case;

  insert into ai_jobs (venue_id, case_id, related_task_id, job_type, input_ref, status)
  values (v_venue, v_case, p_case_task_id, p_job_type, p_input_ref, 'queued')
  returning id into v_id;

  return v_id;
end
$$;

revoke execute on function enqueue_submission_ai_job(uuid, text, jsonb) from public;
grant  execute on function enqueue_submission_ai_job(uuid, text, jsonb) to authenticated;
