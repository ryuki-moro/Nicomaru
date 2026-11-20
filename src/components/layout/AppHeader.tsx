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
        {/* スマートフォン幅で「にこまる」やログアウトが2行に割れないよう、ロゴとボタンは折り返さず、
            縮むのは利用者名だけにする（長い名前は省略し、全体は title で読める） */}
        <Link
          href="/"
          prefetch={false}
          className="shrink-0 whitespace-nowrap text-logo font-bold text-text-primary"
        >
          にこまる
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate text-caption text-text-muted"
            title={`${ROLE_LABEL[role]} / ${displayName}`}
          >
            {ROLE_LABEL[role]} / {displayName}
          </span>
          {role === 'system_admin' && demoMailbox() && (
            <Link href="/dev/mailbox" prefetch={false} className="btn-ghost">
              デモ受信箱
            </Link>
          )}
          {/*
            couple 側のお知らせ（M05）は下部ナビに項目が無いので、どの画面からも1回で開けるよう
            ヘッダーに置く。アイコンだけだと分かりにくいので読み上げ名を付け、押せる範囲は44pxを確保する。
          */}
          {role === 'couple' && (
            <Link
              href="/mypage/notifications"
              prefetch={false}
              aria-label="お知らせ"
              title="お知らせ"
              className="-my-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-button text-text-secondary"
            >
              <svg
                aria-hidden
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6" />
                <path d="M9 17v1a3 3 0 0 0 6 0v-1" />
              </svg>
            </Link>
          )}
          <LogoutButton />
        </div>
      </div>

      {!minimal && isStaff(role) && <StaffNav role={role} />}
    </header>
  );
}
