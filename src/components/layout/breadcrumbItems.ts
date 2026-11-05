/**
 * パンくず（Breadcrumbs）の項目と起点。JSX を持たないので単体テストから直接読める。
 */
import type { Role } from '@/lib/constants';

export interface Crumb {
  label: string;
  /** 省略すると現在地として扱う（最後の項目にだけ使う） */
  href?: string;
}

/** パンくずの起点。ロールの着地点（landingPathFor）と同じ画面にする。 */
export function homeCrumbFor(role: Role): Crumb {
  return role === 'system_admin'
    ? { label: '利用状況', href: '/system' }
    : { label: 'ダッシュボード', href: '/dashboard' };
}

export const DASHBOARD_CRUMB: Crumb = { label: 'ダッシュボード', href: '/dashboard' };
