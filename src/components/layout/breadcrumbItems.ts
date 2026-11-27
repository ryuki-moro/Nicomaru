/**
 * パンくず（Breadcrumbs）の項目と起点。JSX を持たないので単体テストから直接読める。
 */
import type { Role } from '@/lib/constants';
import { publicD1 } from '@/lib/d1/mode';

import { usersLabelFor } from './staffNavItems';

export interface Crumb {
  label: string;
  /** 省略すると現在地として扱う（最後の項目にだけ使う） */
  href?: string;
}

export const DASHBOARD_CRUMB: Required<Crumb> = { label: 'ダッシュボード', href: '/dashboard' };

/**
 * D1版の着地点。立場の主な仕事の画面から始める。
 * planner は案件一覧、admin は管理する職員の一覧、system_admin は運営ダッシュボード
 * （landingPathFor と共有）。
 */
export function d1HomeCrumbFor(role: Role): Required<Crumb> | undefined {
  if (role === 'planner') return { label: '案件一覧', href: '/cases' };
  if (role === 'admin') return { label: usersLabelFor(role), href: '/users' };
  if (role === 'system_admin') return DASHBOARD_CRUMB;
  return undefined;
}

/** パンくずの起点。ロールの着地点（landingPathFor）と同じ画面にする。 */
export function homeCrumbFor(role: Role): Crumb {
  return (publicD1() ? d1HomeCrumbFor(role) : undefined) ?? DASHBOARD_CRUMB;
}

