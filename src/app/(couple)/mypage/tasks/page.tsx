/**
 * M02 宿題・提出物一覧（couple）。
 *
 * 正本: 基本設計書 Version 1.2 4-3「M02 宿題・提出物一覧」。
 *   - 状態フィルタタブの並び・表示名は表6-9（constants.TASK_FILTER_TABS）に従う。
 *   - 既定タブ「すべて」では waived（マイページ表示は「対応不要」）を除外し、
 *     「対応不要」タブでのみ表示する。
 *   - 並びは ORDER BY due_date, display_order, id。
 *   - 行タップで M03 へ。
 *
 * 読み取りのみなので Supabase クライアントから直接 select する（6-5）。
 * 「自分の案件だけ」の絞り込みは付録A の RLS が担保するため、ここでは case_id を指定しない。
 */
import Link from 'next/link';
import { requireRole } from '@/lib/auth/session';
import { usingD1, localDB } from '@/lib/d1/runtime';
import { taskList, taskRow } from '@/lib/d1/tasks';

import { TaskFilterTabs } from '@/app/(couple)/mypage/tasks/TaskFilterTabs';
import { taskDetailHref } from '@/app/(couple)/mypage/tasks/taskLinks';
import { EmptyState } from '@/components/ui/EmptyState';
import { TaskStatusBadge } from '@/components/ui/StatusBadge';
import {
  LIST_PAGE_SIZE,
  TASK_FILTER_TABS,
  TASK_STATUSES,
  TASK_STATUSES_EXCLUDED_FROM_ALL,
  type SubmissionFormat,
  type TaskStatus,
} from '@/lib/constants';
import { formatDateJp, todayInJst } from '@/lib/format';
import { daysBetween, type IsoDate } from '@/lib/services/schedule';
import { resolvePage } from '@/lib/pagination';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { relativeTaskDeadline, TASK_ANSWER_METHOD_LABEL } from '@/lib/task-display';
import { isUuid } from '@/lib/uuid';

export const metadata = { title: '宿題・提出物' };

/** 期限が近い行だけ日付を warning-text にする（design_guide 5.7）。 */
const DUE_SOON_DAYS = 7;

interface TaskRow {
  id: string;
  title: string;
  due_date: IsoDate;
  status: TaskStatus;
  submission_format: SubmissionFormat;
}

/** ?tab= を TASK_FILTER_TABS のキーへ解決する。未知の値は既定タブへ寄せる。 */
function resolveTab(raw: string | undefined) {
  return TASK_FILTER_TABS.find((tab) => tab.key === raw) ?? TASK_FILTER_TABS[0];
}

/**
 * 提出の直後（M03 から ?submitted=<宿題ID> で戻ってきたとき）の知らせ。
 *
 * 文言は URL から受け取らず、ID から引いた宿題名で組み立てる。
 * 見えない宿題（RLS の範囲外）や、提出済みでない宿題では何も出さない。
 */
async function submittedNotice(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  taskId: string | undefined,
): Promise<string | null> {
  if (!isUuid(taskId)) return null;
  const { data } = await supabase
    .from('case_tasks')
    .select('title, status, submission_format')
    .eq('id', taskId)
    .maybeSingle();
  const task = data as Pick<TaskRow, 'title' | 'status' | 'submission_format'> | null;
  if (!task || task.status !== 'submitted') return null;
  return task.submission_format === 'none'
    ? `『${task.title}』の確認をプランナーに伝えました。`
    : `『${task.title}』を提出しました。プランナーの確認をお待ちください。`;
}

function pageHref(tabKey: string, page: number): string {
  const query = new URLSearchParams();
  if (tabKey !== 'all') query.set('tab', tabKey);
  if (page > 1) query.set('page', String(page));
  const search = query.toString();
  return search ? `/mypage/tasks?${search}` : '/mypage/tasks';
}

async function submittedD1Notice(taskId: string | undefined): Promise<string | null> {
  if (!isUuid(taskId)) return null;
  const user = await requireRole('couple');
  try {
    const task = await taskRow(await localDB(), user, taskId);
    if (task.status !== 'submitted') return null;
    return task.submission_format === 'none'
      ? `『${task.title}』の確認をプランナーに伝えました。`
      : `『${task.title}』を提出しました。プランナーの確認をお待ちください。`;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404)
      return null;
    throw error;
  }
}

export default async function TaskListPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string | string[]; submitted?: string }>;
}) {
  const query = await searchParams;
  const tab = resolveTab(query.tab);
  const page = resolvePage(query.page);
  const supabase = usingD1() ? null : await createSupabaseServerClient();
  const notice = supabase
    ? await submittedNotice(supabase, query.submitted)
    : await submittedD1Notice(query.submitted);

  // 「すべて」は waived を除外する。除外リストの補集合を .in() に渡すことで、
  // PostgREST の not.in 記法（値のクォート規則が独特）に依存せず値域を constants 側へ寄せる。
  const statuses: readonly TaskStatus[] =
    tab.statuses ?? TASK_STATUSES.filter((s) => !TASK_STATUSES_EXCLUDED_FROM_ALL.includes(s));

  // 既定の表示件数は50件、以降はページング（4-3 一覧画面共通）。
  // 1件多く取り、次ページの有無を件数の追加問い合わせなしで判定する。
  const from = (page - 1) * LIST_PAGE_SIZE;
  const { data, error } = usingD1()
    ? {
        data: await taskList(await localDB(), await requireRole('couple'), statuses, from),
        error: null,
      }
    : await supabase!
        .from('case_tasks')
        .select('id, title, due_date, status, submission_format')
        .in('status', [...statuses])
        .order('due_date', { ascending: true })
        .order('display_order', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + LIST_PAGE_SIZE);

  const fetched = (data ?? []) as TaskRow[];
  const hasNext = fetched.length > LIST_PAGE_SIZE;
  const tasks = fetched.slice(0, LIST_PAGE_SIZE);
  const today = todayInJst();

  return (
    <div>
      <h1 className="section-head mb-3">宿題・提出物</h1>
      {notice && (
        <div role="status" className="banner-info mb-3">
          <span>{notice}</span>
        </div>
      )}
      <TaskFilterTabs current={tab.key} />

      {error ? (
        <div role="alert" className="banner-error">
          <span>一覧を読み込めませんでした。時間をおいて開き直してください。</span>
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState
          message={
            page > 1 ? 'これ以上の宿題はありません。' : 'このタブに表示する宿題はありません。'
          }
        />
      ) : (
        <ul className="flex flex-col gap-[10px]">
          {tasks.map((task) => {
            const relativeDeadline = relativeTaskDeadline(task.due_date, today, task.status);
            const dueSoon =
              task.status !== 'confirmed' &&
              task.status !== 'waived' &&
              daysBetween(task.due_date, today) <= DUE_SOON_DAYS;
            return (
              <li key={task.id}>
                <Link href={taskDetailHref(task.id)} className="card flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-base text-text-primary">
                      {task.title}
                    </span>
                    <span className="block text-label text-text-secondary">
                      回答方法：{TASK_ANSWER_METHOD_LABEL[task.submission_format]}
                    </span>
                    {/* 相対期限が次の行に回ったとき全角「（」の左の空きで字下げに見えないよう、
                        かっこを半角幅（halt）で組む。同じ行に並ぶときの空きは gap で取る */}
                    <span
                      className={`flex flex-wrap gap-x-1 text-label ${dueSoon ? 'text-warning-text' : 'text-text-muted'}`}
                    >
                      <span>{formatDateJp(task.due_date)}まで</span>
                      {relativeDeadline && (
                        <span className="inline-block [font-feature-settings:'halt']">
                          （{relativeDeadline}）
                        </span>
                      )}
                    </span>
                  </span>
                  <TaskStatusBadge status={task.status} />
                  <ChevronRight />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {(page > 1 || hasNext) && (
        <nav aria-label="ページ送り" className="mt-4 flex items-center justify-between">
          {page > 1 ? (
            <Link href={pageHref(tab.key, page - 1)} className="btn-ghost">
              前の50件
            </Link>
          ) : (
            <span />
          )}
          {hasNext && (
            <Link href={pageHref(tab.key, page + 1)} className="btn-ghost">
              次の50件
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}

/** Tabler Icons の chevron-right（design_guide 6 のアイコンセット）。 */
function ChevronRight() {
  return (
    <svg
      aria-hidden
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted"
    >
      <path d="M9 6l6 6l-6 6" />
    </svg>
  );
}
