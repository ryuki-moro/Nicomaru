/**
 * D02 提出物確認画面 — 確認待ち一覧（4-1／4-3 D02、機能4-3）。
 *
 * 一覧に載せるのは review_status='submitted'（＝プランナーの確認待ち）だけに限定する。
 * couple の一時保存（draft）は RLS の restrictive ポリシーで元々見えないが、
 * 「確認待ち」という画面の意味を式で明示するために条件としても書く（6-7）。
 *
 * 読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select する。
 */
import Link from 'next/link';

import { EmptyState } from '@/components/ui/EmptyState';
import { ReviewStatusBadge } from '@/components/ui/StatusBadge';
import { COUPLE_PROFILE_COLUMNS, LIST_PAGE_SIZE } from '@/lib/constants';
import { decryptPii } from '@/lib/crypto';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface SubmissionRow {
  id: string;
  submitted_at: string;
  case_tasks: {
    id: string;
    title: string;
    due_date: string;
    case_id: string;
    wedding_cases: { id: string; case_code: string; wedding_date: string };
  };
}

interface CoupleProfileRow {
  case_id: string;
  partner_role: string;
  full_name: string | null;
  is_primary_contact: boolean;
}

/** 暗号化列（13-1）。初期投入データなど平文のまま入っている値は復号せずそのまま見せる。 */
function readPii(value: string | null): string {
  if (!value) return '';
  try {
    return decryptPii(value) ?? '';
  } catch {
    return value;
  }
}

const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Tokyo',
});
/** due_date は date 型なので、JST の日付として解釈させてからフォーマットする。 */
const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeZone: 'Asia/Tokyo' });

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page } = await searchParams;
  // 4-3 一覧画面共通: 既定の表示件数は50件、以降はページングとする
  const currentPage = Math.max(1, Number.parseInt(page ?? '1', 10) || 1);
  const offset = (currentPage - 1) * LIST_PAGE_SIZE;

  const supabase = await createSupabaseServerClient();

  const { data, error, count } = await supabase
    .from('task_submissions')
    .select(
      'id, submitted_at,'
      + ' case_tasks!inner ( id, title, due_date, case_id,'
      + ' wedding_cases!inner ( id, case_code, wedding_date ) )',
      { count: 'exact' },
    )
    .eq('review_status', 'submitted')
    .eq('is_latest', true)
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
    const { data: profiles, error: profileError } = await supabase
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
        current ? (profile.is_primary_contact ? `${name}・${current}` : `${current}・${name}`) : name,
      );
    }
  }

  return (
    <div>
      <nav aria-label="パンくず" className="mb-3">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/dashboard" className="text-link hover:underline">
              ダッシュボード
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">提出物確認</li>
        </ol>
      </nav>

      <h1 className="section-head">提出物確認</h1>
      <p className="mt-1 text-caption text-text-muted">
        新郎新婦から届いた提出物のうち、確認待ちのものを表示しています（全 {total} 件）。
      </p>

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
                    <Link
                      href={`/submissions/${row.id}`}
                      className="text-link underline underline-offset-2"
                    >
                      {row.case_tasks.wedding_cases.case_code}
                    </Link>
                  </td>
                  <td>{coupleNames.get(row.case_tasks.case_id) ?? '—'}</td>
                  <td>{row.case_tasks.title}</td>
                  <td className="whitespace-nowrap">
                    {dateFormat.format(new Date(`${row.case_tasks.due_date}T00:00:00+09:00`))}
                  </td>
                  <td className="whitespace-nowrap">
                    {dateTimeFormat.format(new Date(row.submitted_at))}
                  </td>
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
