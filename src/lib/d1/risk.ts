/**
 * リスク算出の D1 版 (6-8)。判定は Supabase 版と共通の純関数
 * src/lib/services/risk.ts (calculateRisk) をそのまま使う。
 * Supabase 版 riskStore.ts との差: D1 には follow_logs と
 * user_profiles.last_login_at が無いため、最終アクティビティは
 * 宿題提出 (task_submissions.submitted_at) の最新のみで近似する。
 * 根拠 (reasons) は必ずスコアとセットで保存・返却する (既存仕様)。
 */
import type { D1Database } from '@cloudflare/workers-types';

import type { Importance, RiskLevel, TaskStatus } from '@/lib/constants';
import { notFound } from '@/lib/errors';
import { todayInJst } from '@/lib/format';
import { calculateRisk, type RiskInput, type RiskResult, type RiskRule } from '@/lib/services/risk';
import type { IsoDate } from '@/lib/services/schedule';

export interface RiskSnapshotView {
  score_value: number;
  score_level: RiskLevel;
  reasons: RiskResult['reasons'];
  calculated_at: string;
  is_current: boolean;
}

interface RuleRow {
  id: string;
  name: string;
  condition_key: string;
  level: RiskLevel;
  score_delta: number;
  priority: number;
  params: string;
  description: string | null;
  active: number;
  venue_id: string | null;
}

/** 式場別ルールが共通 (venue_id NULL) を condition_key 単位で上書きする (riskStore と同規則)。 */
export async function loadRiskRulesD1(db: D1Database, venueId: string): Promise<RiskRule[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM risk_rules WHERE active=1 AND (venue_id IS NULL OR venue_id=?) ORDER BY priority DESC',
    )
    .bind(venueId)
    .all<RuleRow>();
  const byKey = new Map<string, RiskRule>();
  // 共通を先に、式場別を後に置くため priority 順ではなく venue 順で畳む。
  const sorted = [...results].sort(
    (a, b) => (a.venue_id === null ? 0 : 1) - (b.venue_id === null ? 0 : 1),
  );
  for (const row of sorted) {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params) as Record<string, unknown>;
    } catch {
      params = {};
    }
    byKey.set(row.condition_key, {
      id: row.id,
      name: row.name,
      conditionKey: row.condition_key,
      level: row.level,
      scoreDelta: row.score_delta,
      priority: row.priority,
      params,
      description: row.description,
      active: Boolean(row.active),
    });
  }
  return [...byKey.values()];
}

export async function collectRiskInputD1(
  db: D1Database,
  caseId: string,
): Promise<{ input: RiskInput; venueId: string }> {
  const target = await db
    .prepare('SELECT id,venue_id,wedding_date,archived_at FROM wedding_cases WHERE id=?')
    .bind(caseId)
    .first<{ id: string; venue_id: string; wedding_date: string; archived_at: string | null }>();
  if (!target) throw notFound('案件が見つかりません');
  const { results: taskRows } = await db
    .prepare('SELECT id,status,importance,due_date FROM case_tasks WHERE case_id=?')
    .bind(caseId)
    .all<{ id: string; status: TaskStatus; importance: Importance; due_date: string }>();
  const { results: latestSubs } = await db
    .prepare(
      `SELECT s.case_task_id,s.review_status,s.submitted_at FROM task_submissions s
       JOIN case_tasks t ON t.id=s.case_task_id WHERE t.case_id=? AND s.is_latest=1`,
    )
    .bind(caseId)
    .all<{ case_task_id: string; review_status: string; submitted_at: string }>();
  const draftOnly = new Set(
    latestSubs.filter((s) => s.review_status === 'draft').map((s) => s.case_task_id),
  );
  const lastSubmitted = latestSubs
    .map((s) => s.submitted_at)
    .sort()
    .at(-1);
  return {
    venueId: target.venue_id,
    input: {
      today: todayInJst() as IsoDate,
      weddingDate: target.wedding_date.slice(0, 10) as IsoDate,
      tasks: taskRows.map((t) => ({
        id: t.id,
        status: t.status,
        importance: t.importance,
        dueDate: t.due_date.slice(0, 10) as IsoDate,
        hasOnlyDraftSubmission: draftOnly.has(t.id),
      })),
      lastActivityAt: lastSubmitted ? (todayInJst(new Date(lastSubmitted)) as IsoDate) : null,
    },
  };
}

export async function saveRiskSnapshotD1(
  db: D1Database,
  caseId: string,
  result: RiskResult,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare('UPDATE risk_score_snapshots SET is_current=0 WHERE case_id=? AND is_current=1')
      .bind(caseId),
    db
      .prepare(
        'INSERT INTO risk_score_snapshots(id,case_id,risk_rule_id,score_value,score_level,reasons,is_current,calculated_at) VALUES (?,?,?,?,?,?,1,?)',
      )
      .bind(
        id,
        caseId,
        result.primaryRuleId,
        result.scoreValue,
        result.scoreLevel,
        JSON.stringify(result.reasons),
        now,
      ),
  ]);
  if (!results[1].success) throw new Error('リスク算出結果を保存できませんでした');
  return id;
}

/** 1案件のリスクを再計算して保存する。アーカイブ済みは Supabase 版と同じく対象外。 */
export async function recalculateCaseRiskD1(db: D1Database, caseId: string): Promise<RiskResult> {
  const archived = await db
    .prepare('SELECT archived_at FROM wedding_cases WHERE id=?')
    .bind(caseId)
    .first<{ archived_at: string | null }>();
  if (!archived) throw notFound('案件が見つかりません');
  if (archived.archived_at) throw notFound('アーカイブ済みの案件はリスクを算出できません');
  const { input, venueId } = await collectRiskInputD1(db, caseId);
  const rules = await loadRiskRulesD1(db, venueId);
  const result = calculateRisk(input, rules);
  await saveRiskSnapshotD1(db, caseId, result);
  return result;
}

export async function getCurrentRiskD1(
  db: D1Database,
  caseId: string,
): Promise<RiskSnapshotView | null> {
  try {
    const row = await db
      .prepare(
        'SELECT score_value,score_level,reasons,calculated_at FROM risk_score_snapshots WHERE case_id=? AND is_current=1',
      )
      .bind(caseId)
      .first<{
        score_value: number;
        score_level: RiskLevel;
        reasons: string;
        calculated_at: string;
      }>();
    if (!row) return null;
    let reasons: RiskResult['reasons'] = [];
    try {
      reasons = JSON.parse(row.reasons) as RiskResult['reasons'];
    } catch {
      reasons = [];
    }
    return {
      score_value: row.score_value,
      score_level: row.score_level,
      reasons,
      calculated_at: row.calculated_at,
      is_current: true,
    };
  } catch {
    // migration 0012 未適用の DB ではリスク無しとして扱い、案件表示自体は止めない。
    return null;
  }
}
