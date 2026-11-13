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

export function TaskFilterTabs({
  current,
  counts,
}: {
  current: string;
  /** タブのキー → 件数。開く前に「不備あり」が何件かを分かるようにする */
  counts: Readonly<Record<string, number>>;
}) {
  return (
    <nav aria-label="状態で絞り込む" className="mb-3">
      <ul className="flex flex-wrap gap-2">
        {TASK_FILTER_TABS.map((tab) => {
          const active = tab.key === current;
          return (
            <li key={tab.key}>
              <Link
                href={tab.key === 'all' ? '/mypage/tasks' : `/mypage/tasks?tab=${tab.key}`}
                aria-current={active ? 'page' : undefined}
                scroll={false}
                // 指で押しやすいよう高さ44pxを確保する（.badge の上下余白だけだと24px前後になる）
                className={`badge min-h-11 gap-1 px-[14px] text-label ${
                  active
                    ? 'bg-primary font-bold text-white'
                    : 'border border-border-light bg-surface text-text-secondary'
                }`}
              >
                <span>{tab.label}</span>
                <span>
                  {counts[tab.key] ?? 0}
                  <span className="sr-only">件</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
