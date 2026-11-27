/**
 * パンくず（Breadcrumbs）の項目と起点。JSX を持たないので単体テストから直接読める。
 */
import type { Role } from '@/lib/constants';
import { publicD1 } from '@/lib/d1/mode';

export interface Crumb {
  label: string;
  /** 省略すると現在地として扱う（最後の項目にだけ使う） */
  href?: string;
}

export const DASHBOARD_CRUMB: Required<Crumb> = { label: 'ダッシュボード', href: '/dashboard' };

/**
 * D1版の着地点。立場の主な仕事の画面から始める。
 * planner は案件一覧、admin・system_admin はダッシュボード（準備の残り・運営状況を出す）
 * （landingPathFor と共有）。
 */
export function d1HomeCrumbFor(role: Role): Required<Crumb> | undefined {
  if (role === 'planner') return { label: '案件一覧', href: '/cases' };
  if (role === 'admin' || role === 'system_admin') return DASHBOARD_CRUMB;
  return undefined;
}

/**
 * 実際に表示する項目。起点と次の項目が同じ画面名なら起点を省き（着地点が一覧画面そのもののとき）、
 * 残りが現在地だけなら見出しと同じ名前が並ぶだけなので、パンくず自体を出さない。
 */
export function visibleCrumbs(items: readonly Crumb[]): readonly Crumb[] {
  const shown = items.length > 1 && items[0].label === items[1].label ? items.slice(1) : items;
  return shown.length > 1 ? shown : [];
}

/** パンくずの起点。ロールの着地点（landingPathFor）と同じ画面にする。 */
export function homeCrumbFor(role: Role): Crumb {
  return (publicD1() ? d1HomeCrumbFor(role) : undefined) ?? DASHBOARD_CRUMB;
}
