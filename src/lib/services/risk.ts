/**
 * リスクスコア算出（ルールベース）。
 *
 * 正本: 基本設計書 Version 1.2 6-8「業務ロジック：リスク算出」表6-8。
 *   - 成立したルールの score_delta を合計し、least(100, greatest(0, sum)) にクランプする
 *   - score_level は成立ルール中の最も高い level（high > caution > low）
 *   - risk_rule_id には成立ルールのうち priority が最大のものを記録し、全根拠は reasons に持つ
 *   - 判定閾値は risk_rules.params に持ち、コードへ直書きしない
 *   - condition_key はコード側の判定関数と1対1で対応させ、対応表に無いキーは無視する
 *
 * ローカルLLMはスコア判定に使用しない（説明可能性の担保。1-4）。
 * 機能としては Phase 2 だが、仕様が確定しており純関数で書けるためユニットテストごと先に用意する（12-2）。
 */
import {
  IMPORTANT_TASK_LEVELS,
  INCOMPLETE_TASK_STATUSES,
  RISK_LEVEL_RANK,
  UNSUBMITTED_TASK_STATUSES,
  type Importance,
  type RiskLevel,
  type TaskStatus,
} from '@/lib/constants';
import { daysBetween, type IsoDate } from '@/lib/services/schedule';

export interface RiskRule {
  id: string;
  name: string;
  conditionKey: string;
  level: RiskLevel;
  scoreDelta: number;
  priority: number;
  params: Record<string, unknown>;
  description: string | null;
  active: boolean;
}

export interface RiskTask {
  id: string;
  status: TaskStatus;
  importance: Importance;
  dueDate: IsoDate;
  /** 未レビューの一時保存しか無い場合は「未提出」として扱う（6-7／表6-9） */
  hasOnlyDraftSubmission?: boolean;
}

export interface RiskInput {
  today: IsoDate;
  weddingDate: IsoDate;
  tasks: readonly RiskTask[];
  /** マイページログイン・宿題提出・フォロー記録のうち最新のもの（6-8） */
  lastActivityAt: IsoDate | null;
}

export interface RiskReason {
  ruleId: string;
  conditionKey: string;
  name: string;
  level: RiskLevel;
  scoreDelta: number;
  description: string | null;
}

export interface RiskResult {
  scoreValue: number;
  scoreLevel: RiskLevel;
  /** 成立ルールのうち priority 最大のもの。成立0件なら null */
  primaryRuleId: string | null;
  reasons: RiskReason[];
}

/** 未提出の判定。draft しか無い提出は未提出として扱う（6-7）。 */
function isUnsubmitted(task: RiskTask): boolean {
  if (UNSUBMITTED_TASK_STATUSES.includes(task.status)) return true;
  return task.status === 'submitted' && task.hasOnlyDraftSubmission === true;
}

const numberParam = (params: Record<string, unknown>, key: string, fallback: number): number => {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

/**
 * condition_key → 判定関数の対応表。
 * risk_rules に本表へ無いキーが入っていても落ちないよう、呼び出し側で無視する（6-8）。
 */
export const CONDITION_EVALUATORS: Record<string, (input: RiskInput, rule: RiskRule) => boolean> = {
  /** 挙式日まで N 日以内、かつ重要宿題が未提出 */
  important_task_overdue: (input, rule) => {
    const withinDays = numberParam(rule.params, 'within_days', 30);
    const daysToWedding = daysBetween(input.weddingDate, input.today);
    if (daysToWedding > withinDays) return false;
    return input.tasks.some(
      (t) => IMPORTANT_TASK_LEVELS.includes(t.importance) && isUnsubmitted(t),
    );
  },

  /** 期限超過の未提出宿題が存在する（waived は対象外） */
  task_overdue: (input) =>
    input.tasks.some((t) => isUnsubmitted(t) && daysBetween(t.dueDate, input.today) < 0),

  /** 最終アクティビティから N 日以上経過、かつ未完了タスクあり */
  no_activity_days: (input, rule) => {
    const threshold = numberParam(rule.params, 'no_activity_days', 7);
    const hasIncomplete = input.tasks.some((t) => INCOMPLETE_TASK_STATUSES.includes(t.status));
    if (!hasIncomplete) return false;
    if (input.lastActivityAt === null) return true;
    return daysBetween(input.today, input.lastActivityAt) >= threshold;
  },

  /** 提出済だが不備ありの宿題が存在する */
  needs_fix_exists: (input) => input.tasks.some((t) => t.status === 'needs_fix'),
};

/**
 * リスクスコアを算出する。
 * 成立ルールが0件のときは score_value=0 / score_level='low' / primaryRuleId=null を返す（表6-8 最終行）。
 */
export function calculateRisk(input: RiskInput, rules: readonly RiskRule[]): RiskResult {
  const matched: { rule: RiskRule; reason: RiskReason }[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    const evaluate = CONDITION_EVALUATORS[rule.conditionKey];
    // 対応表に無い condition_key は無視する（実装前のルール追加で落ちないため。6-8）
    if (!evaluate) continue;
    if (!evaluate(input, rule)) continue;

    matched.push({
      rule,
      reason: {
        ruleId: rule.id,
        conditionKey: rule.conditionKey,
        name: rule.name,
        level: rule.level,
        scoreDelta: rule.scoreDelta,
        description: rule.description,
      },
    });
  }

  if (matched.length === 0) {
    return { scoreValue: 0, scoreLevel: 'low', primaryRuleId: null, reasons: [] };
  }

  const sum = matched.reduce((acc, m) => acc + m.rule.scoreDelta, 0);
  const scoreValue = Math.min(100, Math.max(0, sum));

  const scoreLevel = matched.reduce<RiskLevel>(
    (acc, m) => (RISK_LEVEL_RANK[m.rule.level] > RISK_LEVEL_RANK[acc] ? m.rule.level : acc),
    'low',
  );

  // priority 最大。同値のときは level の高い方、さらに同値なら id の昇順で決定的に選ぶ。
  const primary = [...matched].sort((a, b) =>
    b.rule.priority - a.rule.priority
    || RISK_LEVEL_RANK[b.rule.level] - RISK_LEVEL_RANK[a.rule.level]
    || a.rule.id.localeCompare(b.rule.id))[0];

  return {
    scoreValue,
    scoreLevel,
    primaryRuleId: primary.rule.id,
    reasons: matched.map((m) => m.reason),
  };
}
