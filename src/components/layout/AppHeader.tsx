/**
 * 全画面共通ヘッダー（4-3 全画面共通仕様）。
 *   サービス名／ログイン中の利用者種別・表示名／ログアウト（機能1-5）。
 *   couple 側は最小構成にする。パンくずはヘッダーではなく各画面が Breadcrumbs で描画する。
 *   staff 側はヘッダー内にグローバルナビ（StaffNav）を常設する。couple 側の主要導線は下部の CoupleNav。
 */
import Link from 'next/link';

import { LogoutButton } from '@/components/layout/LogoutButton';
import { StaffNav } from '@/components/layout/StaffNav';
import { isStaff, ROLE_LABEL, type Role } from '@/lib/constants';

interface Props {
  role: Role;
  displayName: string;
  /** couple 側はヘッダーを最小構成にする */
  minimal?: boolean;
}

export function AppHeader({ role, displayName, minimal = false }: Props) {
  return (
    <header className="no-print border-b border-border-light bg-surface">
      <div
        className={
          minimal
            ? 'mx-auto flex max-w-phone items-center justify-between px-screen py-3'
            : 'mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3'
        }
      >
        <Link href="/" prefetch={false} className="text-logo font-bold text-text-primary">
          にこまる
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-caption text-text-muted">
            {ROLE_LABEL[role]} / {displayName}
          </span>
          <LogoutButton />
        </div>
      </div>

      {!minimal && isStaff(role) && <StaffNav role={role} />}
    </header>
  );
}
