-- BridalHub / にこまる — リスクスコアの保存（Phase 2）
--
-- 正本: 基本設計書 Version 1.2 6-8「業務ロジック：リスク算出」／3-3-5／表6-8。
--
-- 算出そのものは src/lib/services/risk.ts の純関数で行う（ルールベース・説明可能性の担保。1-4）。
-- ここが受け持つのは保存だけ。risk_score_snapshots には select ポリシーしか無く
-- （付録A。表示は planner／admin に限る）、算出結果を書き込む経路が無いため。
--
-- 「一覧表示時に毎回全件再計算せず、更新時・定期処理・明示再計算で保存する」（6-8）という
-- 方針に従い、書き込み口を1つに絞る。

-- 現在値は case_id ごと1件（部分ユニーク risk_score_snapshots_current_uk）。
-- 先に既存の is_current を落としてから insert する（逆順だと一意制約に衝突する）。
create or replace function save_risk_snapshot(
  p_case_id      uuid,
  p_score_value  integer,
  p_score_level  text,
  p_risk_rule_id uuid,
  p_reasons      jsonb
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role text;
  v_id   uuid;
begin
  select u.role into v_role from current_app_user() u;

  -- リスクは planner／admin 向けの情報であり、couple には見せない（5-1／6-3-2）。
  -- 算出の起動も staff に限る。定期処理は Service Role で直接書くため本関数を通らない（表6-4）。
  if v_role is distinct from 'planner' and v_role is distinct from 'admin'
     and v_role is distinct from 'system_admin' then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  if p_case_id is null
     or p_case_id not in (select accessible_case_ids())
     or not case_is_visible(p_case_id) then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  -- アーカイブ済み案件は対象外。
  -- case_is_visible() は admin にアーカイブ済みも「見せる」ため、これだけでは弾けない。
  -- リスクは「次にやること」を促すための指標であり（6-8／3-3-5）、
  -- 終了した案件に付けても D01 の「今日フォローすべきカップル」を汚すだけになる。
  -- 6-12 の定期処理も対象を進行中の案件に限っており、明示再計算だけが通り抜けるのは不整合。
  if exists (select 1 from wedding_cases c
              where c.id = p_case_id and c.archived_at is not null) then
    raise exception 'アーカイブ済みの案件はリスクを算出できません' using errcode = '42501';
  end if;

  update risk_score_snapshots
     set is_current = false
   where case_id = p_case_id and is_current;

  insert into risk_score_snapshots
    (case_id, risk_rule_id, score_value, score_level, reasons, is_current, calculated_at)
  values
    (p_case_id, p_risk_rule_id, p_score_value, p_score_level, coalesce(p_reasons, '[]'::jsonb),
     true, now())
  returning id into v_id;

  return v_id;
end
$$;

revoke execute on function save_risk_snapshot(uuid, integer, text, uuid, jsonb) from public;
grant  execute on function save_risk_snapshot(uuid, integer, text, uuid, jsonb) to authenticated;

-- ------------------------------------------------------- 定期処理の実行記録（6-12）
-- 「各処理は実行記録（実行日時・ジョブ種別・対象件数・HTTPステータス）を残す」（6-5-2／6-12）。
-- pg_net は fire-and-forget のため、記録が無いと失敗を検知できない。
-- S03（利用状況・通知ログ）と10章の監視がこの表を見る。
create table batch_runs (
  id           uuid        primary key default gen_random_uuid(),
  job_type     varchar(50) not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  target_count integer     not null default 0,
  http_status  integer,
  detail       jsonb       not null default '{}'::jsonb,
  error_message text,
  constraint batch_runs_job_type_check
    check (job_type in ('risk_recalculate', 'notifications_dispatch', 'ai_job_reclaim',
                        'case_purge', 'health_check', 'usage_rollup', 'backup',
                        'rate_limit_cleanup'))
);
comment on table batch_runs is
  '定期処理の実行記録（6-12）。pg_net は fire-and-forget のため、この表が失敗検知の基点になる';

create index batch_runs_job_started_idx on batch_runs (job_type, started_at desc);

alter table batch_runs enable row level security;

-- 【注意】20260828000500_rls_policies.sql の
--   grant select, insert, update, delete on all tables in schema public to authenticated
-- は「その時点で存在した表」にしか効かない。以降のマイグレーションで作った表は
-- 個別に grant しないと、RLS ポリシーを書いても permission denied で止まる。
-- 参照は system_admin のみ（S03）。書き込みは内部処理（Service Role）に限る。
grant select on batch_runs to authenticated;
create policy batch_runs_select on batch_runs for select using (is_system_admin());
