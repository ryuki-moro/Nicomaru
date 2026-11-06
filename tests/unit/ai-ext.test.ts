/**
 * AI拡張（Issue #118）の純関数テスト。
 * 日付計算はルールが正（7-5）なので、LLM の出力検証と合わせてここで固定する。
 */
import { describe, expect, it } from 'vitest';

import { aggregateHandover, buildHandoverFallback } from '@/lib/ai/handover';
import { buildReschedulePlan } from '@/lib/ai/reschedule';
import { buildTemplateDraft } from '@/lib/ai/template-draft';
import { translateWithDictionary } from '@/lib/ai/translation-fallback';

describe('translation fallback', () => {
  it('定型文を日→英に訳し、未訳は原文+注意で返す', () => {
    const r = translateWithDictionary('内容を確認いたしました。独自の文です。', 'en');
    expect(r.matched).toBe(1);
    expect(r.output.text).toContain('We have reviewed');
    expect(r.output.cautions.join('')).toContain('原文のまま');
  });
  it('英→日も同じ辞書で戻せる', () => {
    const r = translateWithDictionary('Thank you for your submission.', 'ja');
    expect(r.output.text).toBe('ご提出いただきありがとうございます。');
  });
});

describe('template draft rule', () => {
  it('既存と同名は出さず、残期間を超える項目は出さない', () => {
    const r = buildTemplateDraft({
      existing: [{ name: '席次の作成', due_offset_days: 30 }],
      daysUntilWedding: 40,
    });
    expect(r.templates.map((t) => t.name)).not.toContain('席次の作成');
    expect(r.templates.every((t) => t.due_offset_days <= 40)).toBe(true);
  });
});

describe('handover aggregate', () => {
  it('期限超過と差し戻しを cautions に入れる', () => {
    const agg = aggregateHandover(
      [
        { title: 'A', status: 'confirmed', due_date: '2027-01-01' },
        { title: 'B', status: 'needs_fix', due_date: '2026-12-01' },
        { title: 'C', status: 'not_started', due_date: '2027-02-01' },
      ],
      '2027-01-15',
    );
    const out = buildHandoverFallback({
      caseCode: 'X-001',
      weddingDate: '2027-03-01',
      today: '2027-01-15',
      aggregate: agg,
    });
    expect(out.cautions.join('')).toContain('B');
    expect(agg.confirmed).toBe(1);
  });
});

describe('reschedule rule', () => {
  it('遅延宿題だけを後ろ倒しし、挙式日を超えない', () => {
    const plan = buildReschedulePlan({
      weddingDate: '2027-06-20',
      today: '2027-06-01',
      tasks: [
        {
          id: '1',
          title: '遅延',
          status: 'not_started',
          due_date: '2027-05-21',
          due_offset_days: 30,
        },
        {
          id: '2',
          title: '完了',
          status: 'confirmed',
          due_date: '2027-05-01',
          due_offset_days: 50,
        },
        {
          id: '3',
          title: '未来',
          status: 'not_started',
          due_date: '2027-06-10',
          due_offset_days: 10,
        },
      ],
    });
    expect(plan.shifts.map((s) => s.id)).toEqual(['1']);
    expect(plan.shifts[0].to < '2027-06-20').toBe(true);
    expect(plan.output.explanation).toContain('遅延');
  });
  it('shiftDays 指定では未提出を一律にずらす', () => {
    const plan = buildReschedulePlan({
      weddingDate: '2027-06-20',
      today: '2027-01-01',
      shiftDays: 14,
      tasks: [
        { id: '1', title: 'A', status: 'needs_fix', due_date: '2027-05-21', due_offset_days: 30 },
      ],
    });
    expect(plan.shifts[0].to).toBe('2027-06-04');
  });
});
