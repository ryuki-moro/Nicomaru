'use client';

import { publicD1 } from '@/lib/d1/mode';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isCoupleNavActive, type CoupleNavItem } from '@/components/couple/coupleNavActive';

/**
 * couple 側の主要導線を下部に固定表示する（4-3 全画面共通仕様）。
 *
 * 先頭3件は 4-3 が挙げる M01／M02／M04。K02（案件詳細の couple 向け表示）は
 * 表4-10 で主な利用者に couple を含む Phase 1 画面だが導線の定義が無いため、
 * 既定の3件の並びを崩さないよう後ろに足す。アカウントは設定の位置づけなので末尾に置く。
 *
 * 現在地は色だけに頼らず、上部のバー・太字でも示す。アイコンは Tabler Icons（design_guide 6）。
 * `fixed inset-x-0 bottom-0` は scripts/screenshots.mts が PC の全体撮影で隠すときの目印にしている。
 */
const ITEMS: readonly CoupleNavItem[] = [
  {
    href: '/mypage',
    label: 'ホーム',
    children: ['/mypage/notifications'],
    icon: [
      'M5 12l-2 0l9 -9l9 9l-2 0',
      'M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7',
      'M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6',
    ],
  },
  {
    href: '/mypage/tasks',
    label: '宿題',
    icon: [
      'M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2',
      'M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z',
      'M9 12l.01 0',
      'M13 12l2 0',
      'M9 16l.01 0',
      'M13 16l2 0',
    ],
  },
  {
    href: '/mypage/timeline',
    label: '準備の流れ',
    icon: [
      'M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z',
      'M16 3v4',
      'M8 3v4',
      'M4 11h16',
    ],
  },
  {
    href: '/mypage/case',
    label: '挙式情報',
    icon: ['M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572'],
  },
  {
    href: '/mypage/account',
    label: 'アカウント',
    icon: ['M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0', 'M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2'],
  },
];

export function CoupleNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="主要メニュー"
      className="no-print fixed inset-x-0 bottom-0 z-10 border-t border-border-light bg-surface"
    >
      <ul className="mx-auto flex max-w-phone">
        {ITEMS.filter(
          (item) => !publicD1() || ['/mypage', '/mypage/tasks'].includes(item.href),
        ).map((item) => {
          const active = isCoupleNavActive(item, pathname);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`-mt-px flex flex-col items-center gap-[2px] border-t-2 pt-2 pb-[6px] text-center text-nav ${
                  active
                    ? 'border-primary font-bold text-primary'
                    : 'border-transparent text-text-muted'
                }`}
              >
                <svg
                  aria-hidden
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 2.2 : 1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {item.icon.map((d) => (
                    <path key={d} d={d} />
                  ))}
                </svg>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
