/**
 * D04 フォロー記録画面（4-1／4-3 D04、要件4-4）。
 *
 * 記録は follow_logs へ登録し、直近の記録を一覧表示する。
 * 一覧の読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select し、
 * 登録だけを /api/cases/{caseId}/follow-logs（表6-6）へ投げる。
 * フォロー記録は D03 準備シートと 6-8 リスク算出（最終アクティビティ）の参考情報になる。
 *
 * 4-3 一覧画面共通：既定の表示件数は50件、以降はページング。
 * 打ち切るだけでは51件目以降の記録を参照できなくなるため、
 * K01／M02 と同じく1件多く取って前後リンクを出す（?page=）。
 */
import Link from 'next/link';

import { FollowForm } from '@/app/(staff)/cases/[caseId]/follow/FollowForm';
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { EmptyState } from '@/components/ui/EmptyState';
import { requireStaff } from '@/lib/auth/session';
import { FOLLOW_METHOD_LABEL, LIST_PAGE_SIZE, type FollowMethod } from '@/lib/constants';
import { caseRow } from '@/lib/d1/cases';
import { listFollowLogs } from '@/lib/d1/follow';
import { localDB } from '@/lib/d1/runtime';
import { formatDate, formatDateTime } from '@/lib/format';
import { resolvePage } from '@/lib/pagination';

interface CaseRow {
  id: string;
  case_code: string;
  wedding_date: string;
}

interface CoupleProfileRow {
  full_name: string | null;
  is_primary_contact: boolean;
}

interface FollowLogRow {
  id: string;
  planner_id: string;
  method: FollowMethod;
  note: string | null;
  followed_at: string;
}

export default async function FollowLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { caseId } = await params;
  const page = resolvePage((await searchParams).page);
  const user = await requireStaff();
  const db = await localDB();
  const weddingCase = await caseRow(db, user, caseId);
  const coupleName = weddingCase.couple_profiles.map((p) => p.full_name).join('・');
  const { items: logs, hasNext } = await listFollowLogs(
    db,
    user,
    caseId,
    (page - 1) * LIST_PAGE_SIZE,
    LIST_PAGE_SIZE,
  );
  const pageHref = (target: number) =>
    target > 1 ? `/cases/${caseId}/follow?page=${target}` : `/cases/${caseId}/follow`;
  const plannerNames = new Map<string, string>();
  for (const id of new Set(logs.map((l) => l.planner_id))) {
    const p = await db
      .prepare(
        `SELECT u.name FROM "user" u JOIN user_profiles p ON p.id=u.id WHERE p.id=? AND (p.id=? OR p.venue_id=?)`,
      )
      .bind(id, user.id, user.venueId)
      .first<{ name: string }>();
    if (p) plannerNames.set(id, p.name);
  }

  return (
    <div>
      <Breadcrumbs
        className="mb-3"
        items={[
          DASHBOARD_CRUMB,
          { label: '案件一覧', href: '/cases' },
          { label: weddingCase.case_code, href: `/cases/${caseId}` },
          { label: 'フォロー記録' },
        ]}
      />

      <h1 className="section-head">フォロー記録</h1>
      <p className="mt-1 text-caption text-text-muted">
        {weddingCase.case_code}
        {coupleName && ` / ${coupleName} さま`} ・ 挙式日 {formatDate(weddingCase.wedding_date)}
      </p>

      <section className="card mt-4">
        <h2 className="text-label font-bold text-text-primary">今回のフォローを記録する</h2>
        <p className="mb-3 mt-1 text-caption text-text-muted">
          電話や打ち合わせでのやり取りを残しておくと、次の担当者にも引き継げます。
        </p>
        <FollowForm caseId={caseId} />
      </section>

      <section className="mt-6">
        <h2 className="section-head">これまでの記録</h2>
        {logs.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              message={page > 1 ? 'これ以上の記録はありません。' : 'まだフォロー記録はありません。'}
            />
          </div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">実施日時</th>
                  <th scope="col">手段</th>
                  <th scope="col">担当</th>
                  <th scope="col">メモ</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap">{formatDateTime(log.followed_at)}</td>
                    <td className="whitespace-nowrap">{FOLLOW_METHOD_LABEL[log.method]}</td>
                    <td className="whitespace-nowrap">
                      {plannerNames.get(log.planner_id) ?? '担当プランナー'}
                    </td>
                    <td className="whitespace-pre-wrap">{log.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(page > 1 || hasNext) && (
          <nav aria-label="ページ送り" className="mt-3 flex items-center justify-between">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className="btn-ghost">
                前の{LIST_PAGE_SIZE}件
              </Link>
            ) : (
              <span />
            )}
            {hasNext && (
              <Link href={pageHref(page + 1)} className="btn-ghost">
                次の{LIST_PAGE_SIZE}件
              </Link>
            )}
          </nav>
        )}
      </section>
    </div>
  );
}
