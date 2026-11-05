import type { Role } from '@/lib/constants';

/**
 * planner／admin／system_admin 側の全画面に常設するグローバルナビ（ヘッダー内の横並び）。
 *
 * 出す項目は各画面のロール判定と揃える。開けない画面への導線は出さない（4-3）。
 *   - 宿題テンプレート・プラン種別は admin のみ
 *   - 利用者管理は admin／system_admin
 *   - 式場管理・利用状況（S01〜S03）は system_admin のみ
 * 「式場一覧」「利用状況・通知ログ」は各画面のパンくず・見出しと同じ名前になるため、
 * ナビ側は「式場管理」「利用状況」と短くして、リンク名が重ならないようにする。
 */
export interface NavItem {
  href: string;
  label: string;
  roles: readonly Role[];
}

const ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'ダッシュボード', roles: ['planner', 'admin', 'system_admin'] },
  { href: '/cases', label: '案件一覧', roles: ['planner', 'admin', 'system_admin'] },
  { href: '/submissions', label: '提出物確認', roles: ['planner', 'admin', 'system_admin'] },
  { href: '/notifications', label: '通知履歴', roles: ['planner', 'admin', 'system_admin'] },
  { href: '/templates', label: '宿題テンプレート', roles: ['admin'] },
  { href: '/plan-types', label: 'プラン種別', roles: ['admin'] },
  // 名前は立場で変わる（usersLabelFor）。同じ画面でも管理する相手が違うため。
  { href: '/users', label: '利用者管理', roles: ['admin', 'system_admin'] },
  { href: '/venues', label: '式場管理', roles: ['system_admin'] },
  { href: '/system', label: '利用状況', roles: ['system_admin'] },
];

/** ロールが開ける画面だけを並び順のまま返す。 */
export function staffNavItemsFor(role: Role): readonly NavItem[] {
  return ITEMS.filter((item) => item.roles.includes(role)).map((item) =>
    item.href === '/users' ? { ...item, label: usersLabelFor(role) } : item,
  );
}

/** 利用者管理（U01）の画面名。system_admin は式場管理者とプランナー、admin は自式場のプランナーを扱う。 */
export function usersLabelFor(role: Role): string {
  return role === 'system_admin' ? '職員管理' : 'プランナー管理';
}

/** 利用者登録（U02）で作られる種別。表4-19 の自動設定と同じ規則。 */
export function createdRoleLabelFor(role: Role): string {
  return role === 'system_admin' ? '式場管理者' : 'プランナー';
}
