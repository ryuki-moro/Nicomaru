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
import { demoMailbox } from '@/lib/d1/mode';

/** 立場ごとの帯。同じ画面構成でも、誰として操作しているかを色と文言で示す。白文字とのコントラスト比は4.5以上。 */
const ROLE_BAND: Partial<Record<Role, { className: string; note: string }>> = {
  system_admin: { className: 'bg-[#1f3a5f]', note: '式場管理者の登録・管理を行います' },
  admin: { className: 'bg-[#2f6b4f]', note: '自式場のプランナーと案件を管理します' },
  planner: { className: 'bg-[#a3385f]', note: '担当案件と提出物を確認します' },
};

interface Props {
  role: Role;
  displayName: string;
  /** couple 側はヘッダーを最小構成にする */
  minimal?: boolean;
}

export function AppHeader({ role, displayName, minimal = false }: Props) {
  const band = minimal ? undefined : ROLE_BAND[role];
  return (
    <header className="no-print border-b border-border-light bg-surface">
      {band && (
        <p className={`${band.className} text-caption text-white`}>
          <span className="mx-auto block w-full max-w-6xl px-4 py-1">
            <strong>{ROLE_LABEL[role]}</strong>として操作中　{band.note}
          </span>
        </p>
      )}
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
          {role === 'system_admin' && demoMailbox() && (
            <Link href="/dev/mailbox" prefetch={false} className="btn-ghost">
              デモ受信箱
            </Link>
          )}
          <LogoutButton />
        </div>
      </div>

      {!minimal && isStaff(role) && <StaffNav role={role} />}
    </header>
  );
}
