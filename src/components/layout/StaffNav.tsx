'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { staffNavItemsFor } from '@/components/layout/staffNavItems';
import type { Role } from '@/lib/constants';

/** planner／admin／system_admin 側の全画面に常設するグローバルナビ（ヘッダー内の横並び）。項目は staffNavItems.ts。 */
export function StaffNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const items = staffNavItemsFor(role).filter(
    (item) => process.env.NEXT_PUBLIC_NICOMARU_DB !== 'd1-local' || item.href === '/cases',
  );

  return (
    <nav aria-label="メインメニュー" className="mx-auto w-full max-w-6xl px-4">
      {/* スマホ幅でも全項目が見えるよう、横スクロールではなく折り返す */}
      <ul className="flex flex-wrap gap-x-1">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              {/* 現在地は色だけでなく太字と下線（バー）でも示す */}
              <Link
                href={item.href}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px block border-b-2 px-3 py-2 text-label transition-colors ${
                  active
                    ? 'border-primary font-bold text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
