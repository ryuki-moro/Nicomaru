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
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { EmptyState } from '@/components/ui/EmptyState';
import { ReviewStatusBadge } from '@/components/ui/StatusBadge';
import { requireStaff } from '@/lib/auth/session';
import {
  LIST_PAGE_SIZE,
  REVIEW_STATUS_LABEL,
  type ReviewStatus,
  type TaskStatus,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { localDB } from '@/lib/d1/runtime';
import { coupleNames as d1CoupleNames, pendingSubmissions, submissionRow } from '@/lib/d1/tasks';
import { fromPostgresError } from '@/lib/errors';
import { formatDate, formatDateTime, todayInJst } from '@/lib/format';
import { resolvePage } from '@/lib/pagination';
import { isUuid } from '@/lib/uuid';
import Link from 'next/link';
interface SubmissionRow {
  id: string;
  submitted_at: string;
  case_tasks: {
    id: string;
    title: string;
    due_date: string;
    case_id: string;
    status: TaskStatus;
    wedding_cases: {
      id: string;
      case_code: string;
      wedding_date: string;
    };
  };
}
interface ReviewedRow {
  review_status: ReviewStatus;
  case_tasks: {
    title: string;
    wedding_cases: {
      case_code: string;
    };
  };
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
  searchParams: Promise<{
    page?: string | string[];
    reviewed?: string;
  }>;
}) {
  const { page, reviewed } = await searchParams;
  // 4-3 一覧画面共通: 既定の表示件数は50件、以降はページングとする
  const currentPage = resolvePage(page);
  const offset = (currentPage - 1) * LIST_PAGE_SIZE;
  const user = await requireStaff();
  const notice = await reviewedD1Notice(user, reviewed);
  const { data, error, count } = await pendingSubmissions(await localDB(), user, offset);
  if (error) throw fromPostgresError(error);
  const rows = (data ?? []) as unknown as SubmissionRow[];
  const total = count ?? rows.length;
  const hasNext = offset + rows.length < total;
  const today = todayInJst();
  const caseIds = [...new Set(rows.map((row) => row.case_tasks.case_id))];
  // couple_profiles は memo を列レベル権限で剥奪しているため select * が 42501 になる（付録A）
  const coupleNames = new Map<string, string>();
  if (caseIds.length > 0) {
    const { data: profiles, error: profileError } = {
      data: await d1CoupleNames(await localDB(), user, caseIds),
      error: null,
    };
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
        新郎新婦から届いた提出物のうち、確認待ちのものを期限の近い順に表示しています（全 {total}{' '}
        件）。宿題名を押すと確認画面が開きます。
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
          {/*
            スマートフォンでは横スクロールなしで宿題・期限・状態が見えるよう、案件番号・カップル・
            提出日時の列を畳み、案件番号とカップル名は宿題名の下に出す。
            押す場所は宿題名の1か所にして、行き先（提出物確認）と表示をそろえる。
          */}
          <table className="table min-w-0 sm:min-w-[640px]">
            <thead>
              <tr>
                <th scope="col">宿題</th>
                <th scope="col" className="hidden sm:table-cell">
                  案件番号
                </th>
                <th scope="col" className="hidden sm:table-cell">
                  カップル
                </th>
                <th scope="col">期限</th>
                <th scope="col" className="hidden sm:table-cell">
                  提出日時
                </th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const caseCode = row.case_tasks.wedding_cases.case_code;
                const couple = coupleNames.get(row.case_tasks.case_id) ?? '—';
                // 期限日の当日はまだ期限内。翌日から期限切れとして示す。
                const overdue = row.case_tasks.due_date < today;
                return (
                  <tr key={row.id}>
                    <td>
                      <Link
                        href={`/submissions/${row.id}`}
                        className="inline-flex min-h-[44px] items-center font-bold text-link underline"
                      >
                        {row.case_tasks.title}
                      </Link>
                      <span className="block text-caption text-text-muted sm:hidden">
                        {caseCode}・{couple}
                      </span>
                    </td>
                    <td className="hidden whitespace-nowrap sm:table-cell">{caseCode}</td>
                    <td className="hidden sm:table-cell">{couple}</td>
                    <td>
                      <span className="block whitespace-nowrap">
                        {formatDate(row.case_tasks.due_date)}
                      </span>
                      {/* 色だけに頼らず文字でも期限切れを示す */}
                      {overdue && (
                        <span className="badge-danger mt-1 whitespace-nowrap">期限切れ</span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap sm:table-cell">
                      {formatDateTime(row.submitted_at)}
                    </td>
                    <td className="whitespace-nowrap">
                      <ReviewStatusBadge status="submitted" />
                    </td>
                  </tr>
                );
              })}
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
