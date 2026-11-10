/** S02 式場詳細・変更画面（system_admin、機能8-3）。 */
import { Breadcrumbs, homeCrumbFor } from '@/components/layout/Breadcrumbs';
import { getAppUser } from '@/lib/auth/session';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
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
}: {
  params: Promise<{
    venueId: string;
  }>;
}) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'system_admin') redirect('/error?code=403');
  const { venueId } = await params;
  if (!z.string().uuid().safeParse(venueId).success) notFound();
  let venue: VenueRow | null = null;
  let loadFailed = false;
  {
    try {
      const { localDB } = await import('@/lib/d1/runtime');
      const { getVenueD1 } = await import('@/lib/d1/admin');
      const found = await getVenueD1(await localDB(), user, venueId);
      venue = found
        ? {
            id: found.id,
            name: found.name,
            code: found.code,
            contact_email: found.contact_email,
            active: found.active,
          }
        : null;
    } catch {
      loadFailed = true;
    }
    if (!loadFailed && !venue) notFound();
  }
  // 通信失敗と、本当に対象が存在しない場合を区別する。
  if (!loadFailed && !venue) notFound();
  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          homeCrumbFor(user.role),
          { label: '式場一覧', href: '/venues' },
          { label: venue?.name ?? '式場の詳細・変更' },
        ]}
      />

      <h1 className="section-head">式場の詳細・変更</h1>

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
          <VenueEditForm
            venueId={venue.id}
            code={venue.code}
            initial={{ name: venue.name, contactEmail: venue.contact_email, active: venue.active }}
          />
        )
      )}
    </div>
  );
}
