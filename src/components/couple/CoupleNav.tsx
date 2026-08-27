'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** couple 側の主要導線を下部に固定表示する（4-3 全画面共通仕様）。 */
const ITEMS = [
  { href: '/mypage', label: 'ホーム' },
  { href: '/mypage/tasks', label: '宿題' },
  { href: '/mypage/timeline', label: '準備の流れ' },
] as const;

export function CoupleNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="主要メニュー"
      className="fixed inset-x-0 bottom-0 border-t border-border-light bg-surface"
    >
      <ul className="mx-auto flex max-w-phone">
        {ITEMS.map((item) => {
          const active = pathname === item.href
            || (item.href !== '/mypage' && pathname.startsWith(item.href));
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block py-3 text-center text-nav ${
                  active ? 'font-bold text-primary' : 'text-text-muted'
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
