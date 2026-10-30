/**
 * 新郎新婦の下部ナビ（CoupleNav）の現在地判定。
 * 画面部品から切り出し、単体テストで確かめられるようにしている（staffNavItems と同じ考え方）。
 */
export interface CoupleNavItem {
  href: string;
  label: string;
  icon: readonly string[];
  /**
   * ナビに項目を持たない子画面。開いているあいだ、この項目を現在地にする。
   * お知らせ（M05）は画面遷移図でマイページ（M01）の子画面なので、ホームを現在地にする。
   */
  children?: readonly string[];
}

const within = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * 項目が現在地か。ホーム（/mypage）は配下の画面すべての親になるため、前方一致にしない。
 * 前方一致は「/」で区切って判定する（/mypage/tasks が /mypage/tasksx に当たらないように）。
 */
export function isCoupleNavActive(
  item: Pick<CoupleNavItem, 'href' | 'children'>,
  pathname: string,
) {
  if (item.href === '/mypage' ? pathname === item.href : within(pathname, item.href)) return true;
  return item.children?.some((child) => within(pathname, child)) ?? false;
}
