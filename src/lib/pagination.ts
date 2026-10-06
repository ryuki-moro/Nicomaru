import { LIST_PAGE_SIZE } from '@/lib/constants';

// 取得範囲を32bitの正の整数以内に制限する。次ページ判定用の1件も含める。
const MAX_OFFSET = 2_147_483_647;
export const MAX_LIST_PAGE = Math.floor((MAX_OFFSET - LIST_PAGE_SIZE) / LIST_PAGE_SIZE) + 1;

/** 不正な ?page= は1ページ目として扱う。重複指定も受け付けない。 */
export function resolvePage(raw: string | string[] | null | undefined): number {
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_LIST_PAGE ? page : 1;
}
