import { describe, expect, it } from 'vitest';

import { LIST_PAGE_SIZE } from '@/lib/constants';
import { MAX_LIST_PAGE, resolvePage } from '@/lib/pagination';

describe('一覧のページ番号', () => {
  it.each(['1', '2', '50', '1234', '0002'])('正の10進整数 %s を受け入れる', (raw) => {
    expect(resolvePage(raw)).toBe(Number(raw));
  });

  it.each([
    undefined, null, '', '0', '-1', '1.5', '2abc', 'abc', 'Infinity', '-Infinity',
    'NaN', '1e3', '0x10', '+2', ' 2 ', '2\n', [], ['2'], ['2', '3'],
    '9007199254740992', '99999999999999999999999999999999999999999999999999',
  ])('不正な値 %j は1ページ目にする', (raw) => {
    expect(resolvePage(raw)).toBe(1);
  });

  it('上限ページでも次ページ判定用の1件が32bit範囲に収まる', () => {
    const page = resolvePage(String(MAX_LIST_PAGE));
    const end = (page - 1) * LIST_PAGE_SIZE + LIST_PAGE_SIZE;
    expect(page).toBe(MAX_LIST_PAGE);
    expect(end).toBeLessThanOrEqual(2_147_483_647);
    expect(end + LIST_PAGE_SIZE).toBeGreaterThan(2_147_483_647);
  });

  it('上限を超えるページは1ページ目にする', () => {
    expect(resolvePage(String(MAX_LIST_PAGE + 1))).toBe(1);
    expect(resolvePage(String(Number.MAX_SAFE_INTEGER))).toBe(1);
  });
});
