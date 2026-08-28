/**
 * リスク算出の入力収集と結果の保存（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-8「業務ロジック：リスク算出」／3-3-5。
 *
 * 判定そのものは `@/lib/services/risk` の純関数に閉じている（ルールベース。
 * ローカルLLMは使わない = 判定根拠を画面で説明できるようにするため。1-4）。
 * ここが受け持つのは「DBから入力を集める」「結果を保存する」の2つだけで、
 * こう分けておくとルールの追加・閾値の変更をユニットテストだけで確認できる（11章）。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { type Importance, type TaskStatus } from '@/lib/constants';
import { fromPostgresError, notFound } from '@/lib/errors';
import { todayInJst } from '@/lib/format';
import { calculateRisk, type RiskInput, type RiskResult, type RiskRule } from '@/lib/services/risk';
import type { IsoDate } from '@/lib/services/schedule';

interface RiskRuleRow {
  id: string;
  name: string;
  condition_key: string;
  level: 'low' | 'caution' | 'high';
  score_delta: number;
  priority: number;
  params: Record<string, unknown> | null;
  description: string | null;
  active: boolean;
}

/**
 * 適用するルールを読む。
 *
 * risk_rules は venue_id が NULL のものがシステム共通ルール（表5-x）。
 * 式場別ルールが同じ condition_key を持つ場合は式場別を優先する
 * （部分ユニーク risk_rules_venue_key_uk により、同一 condition_key は式場ごと1件）。
 */
export async function loadRiskRules(
  supabase: SupabaseClient,
  venueId: string,
): Promise<RiskRule[]> {
  const { data, error } = await supabase
    .from('risk_rules')
    .select('id, name, condition_key, level, score_delta, priority, params, description, active')
    .or(`venue_id.is.null,venue_id.eq.${venueId}`)
    .eq('active', true)
    .order('priority', { ascending: false });
  if (error) throw fromPostgresError(error);

  const rows = (data ?? []) as unknown as (RiskRuleRow & { venue_id?: string | null })[];

  // 式場別が共通を上書きする。同じ condition_key が2件来たときだけの処理なので、
  // 件数が少ない前提で素直に走査する。
  const byKey = new Map<string, RiskRule>();
  for (const row of rows) {
    const rule: RiskRule = {
      id: row.id,
      name: row.name,
      conditionKey: row.condition_key,
      level: row.level,
      scoreDelta: row.score_delta,
      priority: row.priority,
      params: row.params ?? {},
      description: row.description,
      active: row.active,
    };
    byKey.set(row.condition_key, rule);
  }
  return [...byKey.values()];
}

interface CaseRow {
  id: string;
  venue_id: string;
  wedding_date: string;
}

interface TaskRow {
  id: string;
  status: TaskStatus;
  importance: Importance;
  due_date: string;
}

/**
 * 6-8 の「最終アクティビティ」を求める。
 * マイページログイン（user_profiles.last_login_at）・宿題提出（case_tasks.last_submitted_at）・
 * フォロー記録（follow_logs.followed_at）のうち最新のもの。
 */
async function lastActivityOf(
  supabase: SupabaseClient,
  caseId: string,
  taskLastSubmittedAt: string | null,
): Promise<IsoDate | null> {
  const candidates: string[] = [];
  if (taskLastSubmittedAt) candidates.push(taskLastSubmittedAt);

  const follow = await supabase
    .from('follow_logs')
    .select('followed_at')
    .eq('case_id', caseId)
    .order('followed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (follow.error) throw fromPostgresError(follow.error);
  if (follow.data) candidates.push((follow.data as { followed_at: string }).followed_at);

  // couple の最終ログイン。case → couple_profiles → user_profiles を辿る。
  const couples = await supabase
    .from('couple_profiles')
    .select('user_profile_id')
    .eq('case_id', caseId)
    .not('user_profile_id', 'is', null);
  if (couples.error) throw fromPostgresError(couples.error);
  const userIds = ((couples.data ?? []) as { user_profile_id: string | null }[])
    .map((r) => r.user_profile_id)
    .filter((id): id is string => id !== null);

  if (userIds.length > 0) {
    const logins = await supabase
      .from('user_profiles')
      .select('last_login_at')
      .in('id', userIds)
      .not('last_login_at', 'is', null)
      .order('last_login_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (logins.error) throw fromPostgresError(logins.error);
    if (logins.data) candidates.push((logins.data as { last_login_at: string }).last_login_at);
  }

  if (candidates.length === 0) return null;
  // ISO 文字列の辞書順は時刻順と一致する。日付部分だけを返す（6-8 は日数で判定する）。
  return candidates.sort().at(-1)!.slice(0, 10);
}

/** 1案件ぶんのリスク算出に必要な入力を集める。 */
export async function collectRiskInput(
  supabase: SupabaseClient,
  caseId: string,
): Promise<{ input: RiskInput; venueId: string }> {
  const caseResult = await supabase
    .from('wedding_cases')
    .select('id, venue_id, wedding_date')
    .eq('id', caseId)
    .maybeSingle();
  if (caseResult.error) throw fromPostgresError(caseResult.error);
  if (!caseResult.data) throw notFound('案件が見つかりません');
  const target = caseResult.data as unknown as CaseRow;

  const tasksResult = await supabase
    .from('case_tasks')
    .select('id, status, importance, due_date, last_submitted_at')
    .eq('case_id', caseId);
  if (tasksResult.error) throw fromPostgresError(tasksResult.error);
  const taskRows = (tasksResult.data ?? []) as unknown as
    (TaskRow & { last_submitted_at: string | null })[];

  // 「submitted だが未レビューの一時保存しか無い」宿題は未提出として扱う（6-7／表6-9）。
  // draft は planner から見えないので、判定は最新提出の review_status で行う。
  const submittedTaskIds = taskRows.filter((t) => t.status === 'submitted').map((t) => t.id);
  const draftOnly = new Set<string>();
  if (submittedTaskIds.length > 0) {
    const latest = await supabase
      .from('task_submissions')
      .select('case_task_id, review_status')
      .in('case_task_id', submittedTaskIds)
      .eq('is_latest', true);
    if (latest.error) throw fromPostgresError(latest.error);
    for (const row of (latest.data ?? []) as { case_task_id: string; review_status: string }[]) {
      if (row.review_status === 'draft') draftOnly.add(row.case_task_id);
    }
  }

  const lastSubmitted = taskRows
    .map((t) => t.last_submitted_at)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1) ?? null;

  return {
    venueId: target.venue_id,
    input: {
      today: todayInJst(),
      weddingDate: target.wedding_date.slice(0, 10),
      tasks: taskRows.map((t) => ({
        id: t.id,
        status: t.status,
        importance: t.importance,
        dueDate: t.due_date.slice(0, 10),
        hasOnlyDraftSubmission: draftOnly.has(t.id),
      })),
      lastActivityAt: await lastActivityOf(supabase, caseId, lastSubmitted),
    },
  };
}

/**
 * 1案件のリスクを再計算して保存する。
 *
 * @param persist 保存経路。staff セッションからは RPC（権限チェック込み）、
 *   定期処理は Service Role で直接書く（表6-4）。呼び出し側が渡し分ける。
 */
export async function recalculateCaseRisk(
  supabase: SupabaseClient,
  caseId: string,
  persist: (result: RiskResult) => Promise<void>,
): Promise<RiskResult> {
  const { input, venueId } = await collectRiskInput(supabase, caseId);
  const rules = await loadRiskRules(supabase, venueId);
  const result = calculateRisk(input, rules);
  await persist(result);
  return result;
}

/** staff セッションからの保存（save_risk_snapshot RPC 経由）。 */
export function persistViaRpc(supabase: SupabaseClient, caseId: string) {
  return async (result: RiskResult) => {
    const { error } = await supabase.rpc('save_risk_snapshot', {
      p_case_id: caseId,
      p_score_value: result.scoreValue,
      p_score_level: result.scoreLevel,
      p_risk_rule_id: result.primaryRuleId,
      p_reasons: result.reasons,
    });
    if (error) throw fromPostgresError(error);
  };
}

/**
 * 定期処理からの保存（Service Role で直接書く。表6-4）。
 * 現在値は case_id ごと1件なので、先に既存を落としてから insert する。
 */
export function persistViaServiceRole(admin: SupabaseClient, caseId: string) {
  return async (result: RiskResult) => {
    const cleared = await admin
      .from('risk_score_snapshots')
      .update({ is_current: false })
      .eq('case_id', caseId)
      .eq('is_current', true);
    if (cleared.error) throw fromPostgresError(cleared.error);

    const inserted = await admin.from('risk_score_snapshots').insert({
      case_id: caseId,
      risk_rule_id: result.primaryRuleId,
      score_value: result.scoreValue,
      score_level: result.scoreLevel,
      reasons: result.reasons,
      is_current: true,
      calculated_at: new Date().toISOString(),
    });
    if (inserted.error) throw fromPostgresError(inserted.error);
  };
}
