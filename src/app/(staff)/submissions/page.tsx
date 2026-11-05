/**
 * D02 提出物確認画面 — 確認待ち一覧（4-1／4-3 D02、機能4-3）。
 *
 * 一覧に載せるのは review_status='submitted'（＝プランナーの確認待ち）だけに限定する。
 * couple の一時保存（draft）は RLS の restrictive ポリシーで元々見えないが、
 * 「確認待ち」という画面の意味を式で明示するために条件としても書く（6-7）。
 *
 * さらに、宿題側が「対応不要」（case_tasks.status='waived'）になったものは除外する。
 * 免除された宿題は 6-8 の未提出判定から外れており確認する必要がないうえ、
 * ここで確認すると case_tasks.status が confirmed で上書きされ、免除が黙って外れるため。
 *
 * 読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select する。
 */
import Link from 'next/link';
import { requireStaff } from '@/lib/auth/session';
import { usingD1, localDB } from '@/lib/d1/runtime';
import { pendingSubmissions, submissionRow, coupleNames as d1CoupleNames } from '@/lib/d1/tasks';

import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ReviewStatusBadge } from '@/components/ui/StatusBadge';
import {
  COUPLE_PROFILE_COLUMNS,
  LIST_PAGE_SIZE,
  REVIEW_STATUS_LABEL,
  type ReviewStatus,
  type TaskStatus,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { fromPostgresError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { resolvePage } from '@/lib/pagination';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isUuid } from '@/lib/uuid';

interface SubmissionRow {
  id: string;
  submitted_at: string;
  case_tasks: {
    id: string;
    title: string;
    due_date: string;
    case_id: string;
    status: TaskStatus;
    wedding_cases: { id: string; case_code: string; wedding_date: string };
  };
}

interface ReviewedRow {
  review_status: ReviewStatus;
  case_tasks: { title: string; wedding_cases: { case_code: string } };
}

/**
 * 確認結果の登録直後（D02 から ?reviewed=<提出ID> で戻ってきたとき）の知らせ。
 *
 * 文言は URL から受け取らず、ID から引いた宿題名・案件番号・確認結果で組み立てる
 * （/error と同じく、偽の案内文を差し込んだURLを配れないようにする）。
 * 見えない提出（RLS の範囲外）や、まだ確認待ちの提出では何も出さない。
 */
async function reviewedNotice(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  submissionId: string | undefined,
): Promise<string | null> {
  if (!isUuid(submissionId)) return null;
  const { data } = await supabase
    .from('task_submissions')
    .select('review_status, case_tasks!inner ( title, wedding_cases!inner ( case_code ) )')
    .eq('id', submissionId)
    .maybeSingle();
  const row = data as unknown as ReviewedRow | null;
  if (!row || (row.review_status !== 'confirmed' && row.review_status !== 'needs_fix')) {
    return null;
  }
  return (
    `『${row.case_tasks.title}』（${row.case_tasks.wedding_cases.case_code}）の確認結果を` +
    `「${REVIEW_STATUS_LABEL[row.review_status]}」で登録しました。`
  );
}

interface CoupleProfileRow {
  case_id: string;
  partner_role: string;
  full_name: string | null;
  is_primary_contact: boolean;
}

async function reviewedD1Notice(
  user: Awaited<ReturnType<typeof requireStaff>>,
  submissionId: string | undefined,
): Promise<string | null> {
  if (!isUuid(submissionId)) return null;
  try {
    const row = await submissionRow(await localDB(), user, submissionId);
    if (row.review_status !== 'confirmed' && row.review_status !== 'needs_fix') return null;
    return (
      `『${row.case_tasks.title}』（${row.case_tasks.wedding_cases.case_code}）の確認結果を` +
      `「${REVIEW_STATUS_LABEL[row.review_status]}」で登録しました。`
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404)
      return null;
    throw error;
  }
}

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; reviewed?: string }>;
}) {
  const { page, reviewed } = await searchParams;
  // 4-3 一覧画面共通: 既定の表示件数は50件、以降はページングとする
  const currentPage = resolvePage(page);
  const offset = (currentPage - 1) * LIST_PAGE_SIZE;

  const user = await requireStaff();
  const supabase = usingD1() ? null : await createSupabaseServerClient();
  const notice = supabase
    ? await reviewedNotice(supabase, reviewed)
    : await reviewedD1Notice(user, reviewed);

  const { data, error, count } = usingD1()
    ? await pendingSubmissions(await localDB(), user, offset)
    : await supabase!
        .from('task_submissions')
        .select(
          'id, submitted_at,' +
            ' case_tasks!inner ( id, title, due_date, case_id, status,' +
            ' wedding_cases!inner ( id, case_code, wedding_date ) )',
          { count: 'exact' },
        )
        .eq('review_status', 'submitted')
        .eq('is_latest', true)
        // 「対応不要」にした宿題は確認対象から外す（表6-9／6-8）。
        // 埋め込みが !inner なので、この条件は親行（task_submissions）ごと絞り込む。
        .neq('case_tasks.status', 'waived')
        // 待たせている提出から順に確認する。同着は id をタイブレークにする（4-3 一覧画面共通）
        .order('submitted_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + LIST_PAGE_SIZE - 1);
  if (error) throw fromPostgresError(error);

  const rows = (data ?? []) as unknown as SubmissionRow[];
  const total = count ?? rows.length;
  const hasNext = offset + rows.length < total;
  const caseIds = [...new Set(rows.map((row) => row.case_tasks.case_id))];

  // couple_profiles は memo を列レベル権限で剥奪しているため select * が 42501 になる（付録A）
  const coupleNames = new Map<string, string>();
  if (caseIds.length > 0) {
    const { data: profiles, error: profileError } = usingD1()
      ? { data: await d1CoupleNames(await localDB(), user, caseIds), error: null }
      : await supabase!
          .from('couple_profiles')
          .select(COUPLE_PROFILE_COLUMNS)
          .in('case_id', caseIds);
    if (profileError) throw fromPostgresError(profileError);

    for (const profile of (profiles ?? []) as unknown as CoupleProfileRow[]) {
      const name = readPii(profile.full_name);
      if (!name) continue;
      const current = coupleNames.get(profile.case_id);
      // 主連絡先を先頭に置く（K03「主連絡先」）
      coupleNames.set(
        profile.case_id,
        current
          ? profile.is_primary_contact
            ? `${name}・${current}`
            : `${current}・${name}`
          : name,
      );
    }
  }

  return (
    <div>
      <Breadcrumbs className="mb-3" items={[DASHBOARD_CRUMB, { label: '提出物確認' }]} />

      <h1 className="section-head">提出物確認</h1>
      <p className="mt-1 text-caption text-text-muted">
        新郎新婦から届いた提出物のうち、確認待ちのものを表示しています（全 {total} 件）。
      </p>

      {notice && (
        <div role="status" className="banner-info mt-4">
          <span>{notice}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState message="確認待ちの提出はありません。" />
        </div>
      ) : (
        <div className="table-wrap mt-4">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">案件番号</th>
                <th scope="col">カップル</th>
                <th scope="col">宿題</th>
                <th scope="col">期限</th>
                <th scope="col">提出日時</th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`/submissions/${row.id}`} className="btn-ghost">
                      {row.case_tasks.wedding_cases.case_code}
                    </Link>
                  </td>
                  <td>{coupleNames.get(row.case_tasks.case_id) ?? '—'}</td>
                  <td>{row.case_tasks.title}</td>
                  <td className="whitespace-nowrap">{formatDate(row.case_tasks.due_date)}</td>
                  <td className="whitespace-nowrap">{formatDateTime(row.submitted_at)}</td>
                  <td>
                    <ReviewStatusBadge status="submitted" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(currentPage > 1 || hasNext) && (
        <nav aria-label="ページ送り" className="mt-3 flex items-center justify-between">
          {currentPage > 1 ? (
            <Link href={`/submissions?page=${currentPage - 1}`} className="btn-ghost">
              前の{LIST_PAGE_SIZE}件
            </Link>
          ) : (
            <span />
          )}
          <span className="text-caption text-text-muted">{currentPage} ページ目</span>
          {hasNext ? (
            <Link href={`/submissions?page=${currentPage + 1}`} className="btn-ghost">
              次の{LIST_PAGE_SIZE}件
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
