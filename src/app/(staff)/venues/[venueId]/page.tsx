/**
 * S02 式場詳細・変更画面（system_admin、機能8-3）。
 *
 * 式場の運営に必要なことを1画面にまとめる: 利用状況の件数、所属する職員と式場管理者の追加、式場情報の変更。
 * 案件の中身は出さない（system_admin は案件を担当しない）。
 */
import { Breadcrumbs, homeCrumbFor } from '@/components/layout/Breadcrumbs';
import { getAppUser } from '@/lib/auth/session';
import type { VenueOverviewRow } from '@/lib/d1/admin';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { resolvePage } from '@/lib/pagination';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { UserTable, type UserListRow } from '../../users/UserTable';
import { VenueEditForm } from './VenueEditForm';
export const dynamic = 'force-dynamic';
interface VenueRow {
  id: string;
  name: string;
  code: string;
  contact_email: string | null;
  active: boolean;
}
export default async function VenueEditPage({
  params,
  searchParams,
}: {
  params: Promise<{
    venueId: string;
  }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'system_admin') redirect('/error?code=403');
  const { venueId } = await params;
  if (!z.string().uuid().safeParse(venueId).success) notFound();
  let venue: VenueRow | null = null;
  let overview: VenueOverviewRow | undefined;
  let staff: UserListRow[] = [];
  let hasNext = false;
  // 職員一覧のページ（50人ごと）
  const page = resolvePage((await searchParams).page);
  let loadFailed = false;
  try {
    const db = await (await import('@/lib/d1/runtime')).localDB();
    const { getVenueD1, venueOverviewD1 } = await import('@/lib/d1/admin');
    const { listStaff } = await import('@/lib/d1/staff');
    const [found, overviews, staffList] = await Promise.all([
      getVenueD1(db, user, venueId),
      venueOverviewD1(db, user),
      listStaff(db, user, { venueId, page }),
    ]);
    venue = found
      ? {
          id: found.id,
          name: found.name,
          code: found.code,
          contact_email: found.contact_email,
          active: found.active,
        }
      : null;
    overview = overviews.find((row) => row.id === venueId);
    hasNext = staffList.hasNext;
    staff = staffList.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      status: row.status,
      venueName: row.venue_name,
    }));
  } catch {
    loadFailed = true;
  }
  // 通信失敗と、本当に対象が存在しない場合を区別する。
  if (!loadFailed && !venue) notFound();
  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          homeCrumbFor(user.role),
          { label: '式場一覧', href: '/venues' },
          { label: venue?.name ?? '式場の詳細' },
        ]}
      />

      <h1 className="section-head">{venue?.name ?? '式場の詳細'}</h1>

      {loadFailed ? (
        <div className="card space-y-3">
          <p role="alert" className="banner-error">
            式場情報を取得できませんでした。時間をおいて再読み込みしてください。
          </p>
          <div className="flex flex-wrap gap-3">
            <a href={`/venues/${venueId}`} className="btn-primary w-auto px-5 text-center">
              再読み込み
            </a>
            <Link href="/venues" className="btn-secondary w-auto px-5 text-center">
              式場一覧へ戻る
            </Link>
          </div>
        </div>
      ) : (
        venue && (
          <>
            {overview && <VenueSummary overview={overview} />}

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h2 className="section-head">職員</h2>
                <Link
                  href={`/users/new?venueId=${venue.id}`}
                  prefetch={false}
                  className="btn-primary w-auto whitespace-nowrap px-5 text-center"
                >
                  式場管理者を追加
                </Link>
              </div>
              <p className="text-caption text-text-muted">
                プランナーの登録は、この式場の式場管理者が行います。
              </p>
              <UserTable rows={staff} showVenue={false} currentUserId={user.id} />
              {(page > 1 || hasNext) && (
                <nav aria-label="職員のページ送り" className="flex items-center justify-between">
                  {page > 1 ? (
                    <Link href={`/venues/${venue.id}?page=${page - 1}`} className="btn-ghost">
                      前の{LIST_PAGE_SIZE}人
                    </Link>
                  ) : (
                    <span />
                  )}
                  {hasNext && (
                    <Link href={`/venues/${venue.id}?page=${page + 1}`} className="btn-ghost">
                      次の{LIST_PAGE_SIZE}人
                    </Link>
                  )}
                </nav>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="section-head">式場情報の変更</h2>
              <VenueEditForm
                venueId={venue.id}
                code={venue.code}
                initial={{
                  name: venue.name,
                  contactEmail: venue.contact_email,
                  active: venue.active,
                }}
              />
            </section>
          </>
        )
      )}
    </div>
  );
}

/** 式場の利用状況。件数だけを出し、設定の不足は文章で示す。 */
function VenueSummary({ overview }: { overview: VenueOverviewRow }) {
  const items = [
    { label: '進行中の案件', value: `${overview.activeCaseCount}件` },
    { label: '利用中のプラン', value: `${overview.planCount}種類` },
    { label: '初回設定待ちの職員', value: `${overview.invitedCount}人` },
  ];
  const notes = [
    overview.adminCount === 0 &&
      '利用中の式場管理者がいません。「式場管理者を追加」から登録してください。',
    overview.planCount === 0 &&
      'プランがまだありません。式場管理者が「プランとやること」で登録します。',
    overview.emptyPlanCount > 0 &&
      `利用中のやることが1件も無いプランが${overview.emptyPlanCount}種類あります。案件を登録してもやることが割り当てられません。`,
  ].filter((note): note is string => Boolean(note));
  return (
    <section className="space-y-2">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="card py-3">
            <dt className="text-caption text-text-muted">{item.label}</dt>
            <dd className="mt-[2px] text-section font-bold text-text-primary">{item.value}</dd>
          </div>
        ))}
      </dl>
      {notes.map((note) => (
        <p key={note} className="banner-warning">
          {note}
        </p>
      ))}
    </section>
  );
}
