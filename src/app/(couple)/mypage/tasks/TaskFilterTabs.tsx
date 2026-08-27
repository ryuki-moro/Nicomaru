/**
 * M02 の状態フィルタタブ。
 *
 * 正本: 基本設計書 Version 1.2 4-3「M02 宿題・提出物一覧」。
 *   タブの並びと表示名は表6-9 を唯一の対応表とする constants.TASK_FILTER_TABS に従い、
 *   ここで独自のラベルを作らない（12-2 単一ソース化）。
 *
 * 絞り込み自体はサーバー側の select で行うため、本コンポーネントは
 * 「いまどのタブか」を URL の ?tab= に載せ替えるだけの薄い部品にしている。
 * 状態を持たないので、戻る操作やリロードでも選択が保たれる。
 */
'use client';

import Link from 'next/link';

import { TASK_FILTER_TABS } from '@/lib/constants';

export function TaskFilterTabs({ current }: { current: string }) {
  return (
    <nav aria-label="状態で絞り込む" className="-mx-screen mb-3 overflow-x-auto px-screen">
      <ul className="flex w-max gap-2">
        {TASK_FILTER_TABS.map((tab) => {
          const active = tab.key === current;
          return (
            <li key={tab.key}>
              <Link
                href={tab.key === 'all' ? '/mypage/tasks' : `/mypage/tasks?tab=${tab.key}`}
                aria-current={active ? 'page' : undefined}
                scroll={false}
                className={
                  active
                    ? 'badge bg-primary text-white'
                    : 'badge border border-border-light bg-surface text-text-secondary'
                }
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
