import { describe, expect, it } from 'vitest';

import { caseTaskCreateSchema } from '@/lib/validation';

/**
 * isoDate が「形式は合っているが存在しない日付」を弾くことの回帰テスト。
 * 引き継ぎ文書（docs/Claudeへの引き継ぎ.md）の既存指摘への対応。
 */
const baseTask = {
  title: 'テストタスク',
  submissionFormat: 'text' as const,
  allowedFileTypes: [],
};

const dueDateOk = (dueDate: string) =>
  caseTaskCreateSchema.safeParse({ ...baseTask, dueDate }).success;

describe('isoDate（caseTaskCreateSchema.dueDate）', () => {
  it('実在する日付は通す', () => {
    expect(dueDateOk('2028-02-28')).toBe(true);
    expect(dueDateOk('2028-12-31')).toBe(true);
  });

  it('うるう年の2月29日は通す', () => {
    expect(dueDateOk('2028-02-29')).toBe(true);
  });

  it('存在しない日付（2月31日）を弾く', () => {
    expect(dueDateOk('2028-02-31')).toBe(false);
  });

  it('うるう年でない年の2月29日を弾く', () => {
    expect(dueDateOk('2027-02-29')).toBe(false);
  });

  it('13月・4月31日を弾く', () => {
    expect(dueDateOk('2028-13-01')).toBe(false);
    expect(dueDateOk('2028-04-31')).toBe(false);
  });

  it('形式が違う文字列を弾く', () => {
    expect(dueDateOk('2028/02/28')).toBe(false);
    expect(dueDateOk('2028-2-8')).toBe(false);
  });
});
