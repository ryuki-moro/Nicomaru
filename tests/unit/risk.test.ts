/**
 * 6-8「業務ロジック：リスク算出」表6-8 の5条件と境界値を検証する（第11章 ユニットテスト）。
 * 仕様からテストを先に用意し、実装を合わせる（12-2）。
 */
import { describe, expect, it } from 'vitest';

import { calculateRisk, type RiskRule, type RiskTask } from '@/lib/services/risk';

/** seed（supabase/seed.sql）と同じ実値のルールセット。 */
const RULES: RiskRule[] = [
  {
    id: 'r-important', name: '挙式30日以内で重要宿題が未提出',
    conditionKey: 'important_task_overdue', level: 'high', scoreDelta: 30, priority: 40,
    params: { within_days: 30 }, description: '挙式日が近く、重要な宿題が未提出です', active: true,
  },
  {
    id: 'r-overdue', name: '期限超過の未提出宿題がある',
    conditionKey: 'task_overdue', level: 'high', scoreDelta: 40, priority: 30,
    params: {}, description: '提出期限を過ぎた宿題があります', active: true,
  },
  {
    id: 'r-inactive', name: '7日以上やり取りが無く未完了あり',
    conditionKey: 'no_activity_days', level: 'caution', scoreDelta: 20, priority: 20,
    params: { no_activity_days: 7 }, description: '最後のやり取りから日数が経っています', active: true,
  },
  {
    id: 'r-needsfix', name: '不備ありの宿題がある',
    conditionKey: 'needs_fix_exists', level: 'caution', scoreDelta: 15, priority: 10,
    params: {}, description: '再提出をお願いしている宿題があります', active: true,
  },
];

const TODAY = '2026-09-15';

const task = (over: Partial<RiskTask> = {}): RiskTask => ({
  id: 't1', status: 'confirmed', importance: 'normal', dueDate: '2026-12-01', ...over,
});

const input = (over: Partial<Parameters<typeof calculateRisk>[0]> = {}) => ({
  today: TODAY,
  weddingDate: '2026-12-01',
  tasks: [] as RiskTask[],
  lastActivityAt: TODAY,
  ...over,
});

describe('成立ルールが無い場合（表6-8 最終行）', () => {
  it('score 0 / low / primaryRuleId null を返す', () => {
    const result = calculateRisk(input({ tasks: [task()] }), RULES);
    expect(result).toEqual({ scoreValue: 0, scoreLevel: 'low', primaryRuleId: null, reasons: [] });
  });

  it('宿題が0件でも落ちない', () => {
    expect(calculateRisk(input(), RULES).scoreLevel).toBe('low');
  });
});

describe('important_task_overdue（挙式30日以内 × 重要宿題が未提出）', () => {
  it('30日以内かつ重要宿題が未提出なら成立する（境界値: ちょうど30日）', () => {
    const result = calculateRisk(
      input({
        weddingDate: '2026-10-15',
        tasks: [task({ status: 'not_started', importance: 'important' })],
      }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).toContain('important_task_overdue');
  });

  it('31日先なら成立しない（境界値）', () => {
    const result = calculateRisk(
      input({
        weddingDate: '2026-10-16',
        tasks: [task({ status: 'not_started', importance: 'important' })],
      }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).not.toContain('important_task_overdue');
  });

  it('normal の宿題では成立しない（「重要宿題」は important 以上）', () => {
    const result = calculateRisk(
      input({ weddingDate: '2026-10-01', tasks: [task({ status: 'not_started', importance: 'normal' })] }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).not.toContain('important_task_overdue');
  });

  it('critical も重要宿題として扱う', () => {
    const result = calculateRisk(
      input({ weddingDate: '2026-10-01', tasks: [task({ status: 'not_started', importance: 'critical' })] }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).toContain('important_task_overdue');
  });

  it('waived は未提出に数えない', () => {
    const result = calculateRisk(
      input({ weddingDate: '2026-10-01', tasks: [task({ status: 'waived', importance: 'critical' })] }),
      RULES,
    );
    expect(result.reasons).toHaveLength(0);
  });

  it('params.within_days を変えると閾値が変わる（コードに直書きしない）', () => {
    const rules = RULES.map((r) =>
      r.id === 'r-important' ? { ...r, params: { within_days: 90 } } : r);
    const result = calculateRisk(
      input({ weddingDate: '2026-11-01', tasks: [task({ status: 'not_started', importance: 'important' })] }),
      rules,
    );
    expect(result.reasons.map((r) => r.conditionKey)).toContain('important_task_overdue');
  });
});

describe('task_overdue（期限超過の未提出宿題）', () => {
  it('期限を1日過ぎた未提出で成立する（境界値）', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'not_started', dueDate: '2026-09-14' })] }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).toContain('task_overdue');
  });

  it('期限当日は成立しない（境界値）', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'not_started', dueDate: TODAY })] }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).not.toContain('task_overdue');
  });

  it('期限超過でも confirmed なら成立しない', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'confirmed', dueDate: '2026-01-01' })] }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).not.toContain('task_overdue');
  });

  it('期限超過でも waived なら成立しない（6-8 の除外規定）', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'waived', dueDate: '2026-01-01' })] }),
      RULES,
    );
    expect(result.reasons).toHaveLength(0);
  });

  it('submitted でも一時保存しか無ければ未提出として扱う（6-7）', () => {
    const result = calculateRisk(
      input({
        tasks: [task({ status: 'submitted', dueDate: '2026-01-01', hasOnlyDraftSubmission: true })],
      }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).toContain('task_overdue');
  });
});

describe('no_activity_days（最終アクティビティ）', () => {
  it('7日経過かつ未完了ありで成立する（境界値: ちょうど7日）', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'not_started' })], lastActivityAt: '2026-09-08' }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).toContain('no_activity_days');
  });

  it('6日では成立しない（境界値）', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'not_started' })], lastActivityAt: '2026-09-09' }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).not.toContain('no_activity_days');
  });

  it('未完了タスクが無ければ成立しない', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'confirmed' })], lastActivityAt: '2026-01-01' }),
      RULES,
    );
    expect(result.reasons).toHaveLength(0);
  });

  it('アクティビティが一度も無ければ成立する', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'not_started' })], lastActivityAt: null }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey)).toContain('no_activity_days');
  });
});

describe('needs_fix_exists（不備あり）', () => {
  it('needs_fix の宿題があれば成立する', () => {
    const result = calculateRisk(input({ tasks: [task({ status: 'needs_fix' })] }), RULES);
    expect(result.reasons.map((r) => r.conditionKey)).toContain('needs_fix_exists');
  });
});

describe('スコアの合成（6-8 の算出式）', () => {
  it('成立ルールの score_delta を合計する', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'needs_fix', dueDate: '2026-09-01' })], lastActivityAt: TODAY }),
      RULES,
    );
    // task_overdue(40) + needs_fix_exists(15)
    expect(result.scoreValue).toBe(55);
  });

  it('合計は100でクランプされる', () => {
    const heavy = RULES.map((r) => ({ ...r, scoreDelta: 90 }));
    const result = calculateRisk(
      input({
        weddingDate: '2026-10-01',
        tasks: [task({ status: 'needs_fix', importance: 'critical', dueDate: '2026-09-01' })],
        lastActivityAt: null,
      }),
      heavy,
    );
    expect(result.scoreValue).toBe(100);
  });

  it('score_level は成立ルール中の最も高い level', () => {
    const result = calculateRisk(
      input({ tasks: [task({ status: 'needs_fix', dueDate: '2026-09-01' })] }),
      RULES,
    );
    expect(result.scoreLevel).toBe('high');
  });

  it('caution だけなら caution', () => {
    const result = calculateRisk(input({ tasks: [task({ status: 'needs_fix' })] }), RULES);
    expect(result.scoreLevel).toBe('caution');
  });

  it('primaryRuleId は priority が最大のルール', () => {
    const result = calculateRisk(
      input({
        weddingDate: '2026-10-01',
        tasks: [task({ status: 'not_started', importance: 'critical', dueDate: '2026-09-01' })],
      }),
      RULES,
    );
    // important(priority 40) > overdue(30) > inactive(20)
    expect(result.primaryRuleId).toBe('r-important');
  });

  it('成立した全ルールを reasons に保持する', () => {
    const result = calculateRisk(
      input({
        weddingDate: '2026-10-01',
        tasks: [task({ status: 'needs_fix', importance: 'critical', dueDate: '2026-09-01' })],
        lastActivityAt: null,
      }),
      RULES,
    );
    expect(result.reasons.map((r) => r.conditionKey).sort()).toEqual(
      ['important_task_overdue', 'needs_fix_exists', 'no_activity_days', 'task_overdue'],
    );
  });
});

describe('ルールの取り扱い', () => {
  it('active=false のルールは評価しない', () => {
    const rules = RULES.map((r) => ({ ...r, active: false }));
    expect(calculateRisk(input({ tasks: [task({ status: 'needs_fix' })] }), rules).reasons)
      .toHaveLength(0);
  });

  it('対応表に無い condition_key は無視する（実装前のルール追加で落ちない）', () => {
    const rules: RiskRule[] = [
      ...RULES,
      { id: 'r-future', name: '将来のルール', conditionKey: 'not_implemented_yet',
        level: 'high', scoreDelta: 99, priority: 99, params: {}, description: null, active: true },
    ];
    const result = calculateRisk(input({ tasks: [task({ status: 'needs_fix' })] }), rules);
    expect(result.scoreValue).toBe(15);
    expect(result.primaryRuleId).toBe('r-needsfix');
  });

  it('ルールが1件も無ければ low', () => {
    expect(calculateRisk(input({ tasks: [task({ status: 'needs_fix' })] }), []).scoreLevel).toBe('low');
  });
});
