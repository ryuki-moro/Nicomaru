import { describe, expect, it } from 'vitest';

import { taskTabCount } from '@/lib/task-display';

describe('状態フィルタの件数', () => {
  const counts = { not_started: 3, needs_fix: 1, waived: 2 };

  it('「すべて」は除外する状態以外を合計する', () => {
    expect(taskTabCount(null, counts, ['waived'])).toBe(4);
  });

  it('状態ごとのタブはその状態だけを数え、該当なしは0件にする', () => {
    expect(taskTabCount(['needs_fix'], counts, ['waived'])).toBe(1);
    expect(taskTabCount(['waived'], counts, ['waived'])).toBe(2);
    expect(taskTabCount(['confirmed'], counts, ['waived'])).toBe(0);
  });
});
