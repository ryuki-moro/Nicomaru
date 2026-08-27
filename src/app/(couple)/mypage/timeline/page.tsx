/**
 * M04 準備タイムライン表示（couple）。
 *
 * 正本: 基本設計書 Version 1.2 4-3「M04 準備タイムライン表示」。
 *   - 時系列タイムライン（縦スクロール）。タスク名・予定期日・関連宿題を表示する。
 *   - リスクスコアは非表示。「関連宿題を見る」で M03 へ。
 *   - phase_name（例：3か月前・1か月前・直前）で見出しをまとめる。値は割当時に
 *     サービス層の phaseNameFor() で決まっており、ここでは再計算しない（6-6-2）。
 *
 * 読み取りのみなので Supabase クライアントから直接 select する（6-5）。
 * 対象案件の絞り込みは付録A の RLS に委ねる。
 */
import Link from 'next/link';

import { EmptyState } from '@/components/ui/EmptyState';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { formatDateJp } from '@/lib/format';
import { type IsoDate } from '@/lib/services/schedule';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: '準備タイムライン' };

interface TimelineRow {
  id: string;
  title: string;
  description: string | null;
  due_date: IsoDate;
  phase_name: string | null;
  related_task_id: string | null;
}

interface PhaseGroup {
  phase: string;
  items: TimelineRow[];
}

/**
 * due_date 昇順で並んだ行を phase_name ごとにまとめる。
 * 並び替えはせず「先頭から連続する同じ見出しをまとめる」だけにして、
 * 時系列（due_date 昇順）が見出しの都合で崩れないようにする。
 */
function groupByPhase(rows: readonly TimelineRow[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  for (const row of rows) {
    const phase = row.phase_name ?? 'これから';
    const last = groups[groups.length - 1];
    if (last && last.phase === phase) last.items.push(row);
    else groups.push({ phase, items: [row] });
  }
  return groups;
}

/** ?page= を1始まりのページ番号にする。壊れた値は1ページ目へ寄せる。 */
function resolvePage(raw: string | undefined): number {
  const parsed = Number(raw ?? '1');
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = resolvePage((await searchParams).page);
  const supabase = await createSupabaseServerClient();

  // 既定の表示件数は50件、以降はページング（4-3 一覧画面共通）。
  // 1件多く取り、次ページの有無を件数の追加問い合わせなしで判定する。
  const from = (page - 1) * LIST_PAGE_SIZE;
  const { data, error } = await supabase
    .from('timeline_items')
    .select('id, title, description, due_date, phase_name, related_task_id')
    .order('due_date', { ascending: true })
    .order('display_order', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + LIST_PAGE_SIZE);

  if (error) {
    return (
      <div role="alert" className="banner-error">
        <span>タイムラインを読み込めませんでした。時間をおいて開き直してください。</span>
      </div>
    );
  }

  const fetched = (data ?? []) as TimelineRow[];
  const hasNext = fetched.length > LIST_PAGE_SIZE;
  const groups = groupByPhase(fetched.slice(0, LIST_PAGE_SIZE));

  return (
    <div>
      <h1 className="section-head mb-3">準備タイムライン</h1>

      {groups.length === 0 ? (
        <EmptyState
          message={
            page > 1
              ? 'これ以上の項目はありません。'
              : 'タイムラインはまだ作成されていません。担当プランナーが準備中です。'
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.phase}>
              <h2 className="mb-2 text-label font-bold text-primary-dark">{group.phase}</h2>
              {/* 縦線で時系列であることを示す（design_guide 5.9 timeline-link 行の派生） */}
              <ol className="flex flex-col gap-[10px] border-l-2 border-border-light pl-4">
                {group.items.map((item) => (
                  <li key={item.id} className="card">
                    <p className="text-label text-text-muted">{formatDateJp(item.due_date)}</p>
                    <p className="text-base text-text-primary">{item.title}</p>
                    {item.description && (
                      <p className="mt-1 whitespace-pre-wrap text-label text-text-secondary">
                        {item.description}
                      </p>
                    )}
                    {item.related_task_id && (
                      <Link
                        href={`/mypage/tasks/${item.related_task_id}`}
                        className="btn-ghost mt-2 inline-block"
                      >
                        関連宿題を見る
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      {(page > 1 || hasNext) && (
        <nav aria-label="ページ送り" className="mt-4 flex items-center justify-between">
          {page > 1 ? (
            <Link
              href={page - 1 === 1 ? '/mypage/timeline' : `/mypage/timeline?page=${page - 1}`}
              className="btn-ghost"
            >
              前の50件
            </Link>
          ) : (
            <span />
          )}
          {hasNext && (
            <Link href={`/mypage/timeline?page=${page + 1}`} className="btn-ghost">
              次の50件
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
