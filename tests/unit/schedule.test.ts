/**
 * 6-6-2「宿題一括割当とトランザクション境界」の仕様からテストを先に用意し、実装を合わせる（12-2）。
 * 第11章 ユニットテスト行の対象（タイムライン逆算・案件更新時の期限再計算）。
 */
import { describe, expect, it } from 'vitest';

import {
  daysBetween,
  daysUntilWedding,
  dueDateFrom,
  nextActions,
  phaseNameFor,
  planTasks,
  previewPlanChange,
  recalculateDueDates,
  type ExistingTask,
  type TemplateForAssign,
} from '@/lib/services/schedule';

const template = (over: Partial<TemplateForAssign> = {}): TemplateForAssign => ({
  taskTemplateId: 't1',
  title: 'ゲストリスト提出',
  description: null,
  submissionFormat: 'file',
  allowedFileTypes: ['csv'],
  options: {},
  importance: 'critical',
  dueOffsetDays: 60,
  dueOffsetDaysOverride: null,
  isRequired: true,
  displayOrder: 1,
  ...over,
});

describe('dueDateFrom（挙式日からの逆算）', () => {
  it('挙式日から offset 日前を返す', () => {
    expect(dueDateFrom('2026-10-10', 60)).toBe('2026-08-11');
  });

  it('offset 0 は挙式日当日', () => {
    expect(dueDateFrom('2026-10-10', 0)).toBe('2026-10-10');
  });

  it('月またぎ・うるう年を跨いでもずれない', () => {
    expect(dueDateFrom('2028-03-01', 1)).toBe('2028-02-29');
    expect(dueDateFrom('2027-03-01', 1)).toBe('2027-02-28');
    expect(dueDateFrom('2026-01-01', 1)).toBe('2025-12-31');
  });

  it('年をまたぐ長い逆算でもずれない', () => {
    expect(dueDateFrom('2026-01-15', 365)).toBe('2025-01-15');
  });

  it('負の逆算日数・非整数は拒否する', () => {
    expect(() => dueDateFrom('2026-10-10', -1)).toThrow();
    expect(() => dueDateFrom('2026-10-10', 1.5)).toThrow();
  });

  it('日付形式が不正なら拒否する', () => {
    expect(() => dueDateFrom('2026/10/10', 1)).toThrow();
    expect(() => dueDateFrom('2026-13-01', 1)).toThrow();
  });
});

describe('daysBetween / daysUntilWedding', () => {
  it('日数差を返す', () => {
    expect(daysBetween('2026-10-10', '2026-10-01')).toBe(9);
    expect(daysBetween('2026-10-01', '2026-10-10')).toBe(-9);
    expect(daysBetween('2026-10-10', '2026-10-10')).toBe(0);
  });

  it('挙式日を過ぎていれば負値になる', () => {
    expect(daysUntilWedding('2026-10-01', '2026-10-05')).toBe(-4);
  });
});

describe('planTasks（宿題一括割当）', () => {
  it('プラン固有の逆算日数がテンプレート値を上書きする', () => {
    const [task] = planTasks('2026-10-10', [template({ dueOffsetDaysOverride: 30 })]);
    expect(task.dueDate).toBe('2026-09-10');
  });

  it('上書きが無ければテンプレート値を使う', () => {
    const [task] = planTasks('2026-10-10', [template()]);
    expect(task.dueDate).toBe('2026-08-11');
  });

  it('提出形式・受入形式・選択肢・必須・重要度・表示順をスナップショットする', () => {
    const [task] = planTasks('2026-10-10', [
      template({
        submissionFormat: 'select',
        allowedFileTypes: [],
        options: { choices: ['A', 'B'] },
        isRequired: false,
        importance: 'important',
        displayOrder: 7,
      }),
    ]);
    expect(task).toMatchObject({
      submissionFormat: 'select',
      allowedFileTypes: [],
      options: { choices: ['A', 'B'] },
      isRequired: false,
      importance: 'important',
      displayOrder: 7,
    });
  });

  it('再実行時は未割当のテンプレート分のみを返す（既存はエラーにしない）', () => {
    const templates = [template({ taskTemplateId: 't1' }), template({ taskTemplateId: 't2' })];
    const planned = planTasks('2026-10-10', templates, ['t1']);
    expect(planned.map((t) => t.taskTemplateId)).toEqual(['t2']);
  });

  it('すべて割当済みなら空配列を返す', () => {
    const templates = [template({ taskTemplateId: 't1' })];
    expect(planTasks('2026-10-10', templates, ['t1'])).toEqual([]);
  });
});

describe('phaseNameFor（タイムラインの区分）', () => {
  it.each([
    [200, '6か月前'],
    [180, '6か月前'],
    [120, '3か月前'],
    [90, '3か月前'],
    [60, '2か月前'],
    [30, '1か月前'],
    [14, '2週間前'],
    [7, '1週間前'],
    [3, '直前'],
    [0, '直前'],
  ])('挙式日の %i 日前は %s', (offset, expected) => {
    expect(phaseNameFor('2026-10-10', dueDateFrom('2026-10-10', offset))).toBe(expected);
  });
});

describe('recalculateDueDates（挙式日変更）', () => {
  const tasks: ExistingTask[] = [
    { id: 'a', taskTemplateId: 't1', title: '未着手', status: 'not_started', dueDate: '2026-08-11', dueOffsetDays: 60 },
    { id: 'b', taskTemplateId: 't2', title: '不備あり', status: 'needs_fix', dueDate: '2026-09-10', dueOffsetDays: 30 },
    { id: 'c', taskTemplateId: 't3', title: '提出済', status: 'submitted', dueDate: '2026-09-20', dueOffsetDays: 20 },
    { id: 'd', taskTemplateId: 't4', title: '確認済', status: 'confirmed', dueDate: '2026-09-25', dueOffsetDays: 15 },
    { id: 'e', taskTemplateId: 't5', title: '対応不要', status: 'waived', dueDate: '2026-09-26', dueOffsetDays: 14 },
    { id: 'f', taskTemplateId: null, title: '個別追加', status: 'not_started', dueDate: '2026-09-01', dueOffsetDays: null },
  ];

  it('未提出（not_started／needs_fix）だけを再計算する', () => {
    const changes = recalculateDueDates('2026-11-10', tasks);
    expect(changes.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('submitted／confirmed／waived は据え置く', () => {
    const changed = new Set(recalculateDueDates('2026-11-10', tasks).map((c) => c.id));
    expect(changed.has('c')).toBe(false);
    expect(changed.has('d')).toBe(false);
    expect(changed.has('e')).toBe(false);
  });

  it('逆算日数を持たない個別追加の宿題は対象外', () => {
    const changed = new Set(recalculateDueDates('2026-11-10', tasks).map((c) => c.id));
    expect(changed.has('f')).toBe(false);
  });

  it('新旧の期限を差分として返す（K04 の差分確認ダイアログ用）', () => {
    const [change] = recalculateDueDates('2026-11-10', tasks);
    expect(change).toEqual({ id: 'a', title: '未着手', from: '2026-08-11', to: '2026-09-11' });
  });

  it('期限が変わらない宿題は差分に含めない', () => {
    expect(recalculateDueDates('2026-10-10', tasks)).toEqual([]);
  });
});

describe('previewPlanChange（プラン種別変更）', () => {
  const existing: ExistingTask[] = [
    { id: 'a', taskTemplateId: 'old1', title: '旧・未着手', status: 'not_started', dueDate: '2026-08-11', dueOffsetDays: 60 },
    { id: 'b', taskTemplateId: 'old2', title: '旧・提出済', status: 'submitted', dueDate: '2026-08-20', dueOffsetDays: 51 },
    { id: 'c', taskTemplateId: 'both', title: '両方にある', status: 'not_started', dueDate: '2026-09-10', dueOffsetDays: 30 },
  ];
  const newTemplates = [
    template({ taskTemplateId: 'both', title: '両方にある' }),
    template({ taskTemplateId: 'new1', title: '新規', dueOffsetDays: 45 }),
  ];

  it('旧プラン由来かつ not_started を waived にする', () => {
    const { waived } = previewPlanChange('2026-10-10', existing, newTemplates);
    expect(waived).toEqual([{ id: 'a', title: '旧・未着手' }]);
  });

  it('提出済みの宿題は残す（削除も waived もしない）', () => {
    const { kept } = previewPlanChange('2026-10-10', existing, newTemplates);
    expect(kept.map((k) => k.id)).toEqual(['b', 'c']);
  });

  it('新プランで増えるテンプレートだけを追加対象にする', () => {
    const { added } = previewPlanChange('2026-10-10', existing, newTemplates);
    expect(added).toEqual([
      { taskTemplateId: 'new1', title: '新規', dueDate: '2026-08-26' },
    ]);
  });

  it('個別追加の宿題（task_template_id が NULL）は waived にしない', () => {
    const withManual: ExistingTask[] = [
      ...existing,
      { id: 'm', taskTemplateId: null, title: '個別', status: 'not_started', dueDate: '2026-09-01', dueOffsetDays: null },
    ];
    const { waived, kept } = previewPlanChange('2026-10-10', withManual, newTemplates);
    expect(waived.map((w) => w.id)).not.toContain('m');
    expect(kept.map((k) => k.id)).toContain('m');
  });
});

describe('nextActions（M01「次にやること」）', () => {
  const tasks = [
    { id: 'z', status: 'not_started' as const, dueDate: '2026-08-11', displayOrder: 1 },
    { id: 'a', status: 'not_started' as const, dueDate: '2026-08-11', displayOrder: 1 },
    { id: 'b', status: 'needs_fix' as const, dueDate: '2026-08-01', displayOrder: 5 },
    { id: 'c', status: 'confirmed' as const, dueDate: '2026-07-01', displayOrder: 1 },
    { id: 'd', status: 'waived' as const, dueDate: '2026-07-02', displayOrder: 1 },
    { id: 'e', status: 'submitted' as const, dueDate: '2026-08-20', displayOrder: 1 },
    { id: 'f', status: 'not_started' as const, dueDate: '2026-08-11', displayOrder: 0 },
  ];

  it('confirmed／waived を除外する', () => {
    const ids = nextActions(tasks, 10).map((t) => t.id);
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('d');
  });

  it('due_date → display_order → id の順に並ぶ', () => {
    expect(nextActions(tasks, 10).map((t) => t.id)).toEqual(['b', 'f', 'a', 'z', 'e']);
  });

  it('既定で最大3件', () => {
    expect(nextActions(tasks)).toHaveLength(3);
  });
});
