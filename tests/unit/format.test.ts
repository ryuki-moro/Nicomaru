import { describe, expect, it } from 'vitest';

import { formatDueRelative } from '@/lib/format';

describe('期限の相対表示', () => {
  it('期限が先なら残り日数を返す', () => {
    expect(formatDueRelative('2026-10-16', '2026-10-15')).toBe('あと1日');
    expect(formatDueRelative('2026-10-25', '2026-10-15')).toBe('あと10日');
  });

  it('期限が今日なら「今日まで」を返す', () => {
    expect(formatDueRelative('2026-10-15', '2026-10-15')).toBe('今日まで');
  });

  it('期限を過ぎていれば過ぎた日数を返す', () => {
    expect(formatDueRelative('2026-10-14', '2026-10-15')).toBe('1日過ぎています');
    expect(formatDueRelative('2026-10-01', '2026-10-15')).toBe('14日過ぎています');
  });

  it('月・年をまたいでも暦日で数える', () => {
    expect(formatDueRelative('2026-11-01', '2026-10-31')).toBe('あと1日');
    expect(formatDueRelative('2027-01-01', '2026-12-31')).toBe('あと1日');
    expect(formatDueRelative('2026-02-28', '2026-03-01')).toBe('1日過ぎています');
  });
});
