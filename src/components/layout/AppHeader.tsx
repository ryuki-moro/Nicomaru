/**
 * 全画面共通ヘッダー（4-3 全画面共通仕様）。
 *   サービス名／ログイン中の利用者種別・表示名／ログアウト（機能1-5）。
 *   planner・admin 側画面にはパンくずを置き、couple 側は最小構成にする。
 */
import Link from 'next/link';

import { LogoutButton } from '@/components/layout/LogoutButton';
import { ROLE_LABEL, type Role } from '@/lib/constants';

export interface Crumb {
  label: string;
  href?: string;
}

interface Props {
  role: Role;
  displayName: string;
  /** planner／admin 側のみ。couple 側は渡さない */
  breadcrumbs?: Crumb[];
  /** couple 側はヘッダーを最小構成にする */
  minimal?: boolean;
}

export function AppHeader({ role, displayName, breadcrumbs, minimal = false }: Props) {
  return (
    <header className="border-b border-border-light bg-surface">
      <div
        className={
          minimal
            ? 'mx-auto flex max-w-phone items-center justify-between px-screen py-3'
            : 'mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3'
        }
      >
        <Link href="/" className="text-logo font-bold text-text-primary">
          にこまる
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-caption text-text-muted">
            {ROLE_LABEL[role]} / {displayName}
          </span>
          <LogoutButton />
        </div>
      </div>

      {!minimal && breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="パンくず" className="mx-auto w-full max-w-6xl px-4 pb-2">
          <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
            {breadcrumbs.map((crumb, index) => (
              <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                {index > 0 && <span aria-hidden>/</span>}
                {crumb.href ? (
                  <Link href={crumb.href} className="text-link hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
    </header>
  );
}
