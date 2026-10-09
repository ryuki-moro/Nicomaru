/** S02 式場詳細・変更画面（system_admin、機能8-3）。 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';

import { getAppUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { VenueEditForm } from './VenueEditForm';

export const dynamic = 'force-dynamic';

interface VenueRow {
  id: string;
  name: string;
  code: string;
  contact_email: string | null;
  active: boolean;
}

export default async function VenueEditPage({ params }: { params: Promise<{ venueId: string }> }) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'system_admin') redirect('/error?code=403');

  const { venueId } = await params;
  if (!z.string().uuid().safeParse(venueId).success) notFound();

  let venue: VenueRow | null = null;
  let loadFailed = false;
  try {
    // 式場の読み取り・更新は Service Role を使わず、RLS にも認可を委ねる。
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('venues')
      .select('id, name, code, contact_email, active')
      .eq('id', venueId)
      .maybeSingle();
    if (error) loadFailed = true;
    else venue = data as VenueRow | null;
  } catch {
    loadFailed = true;
  }

  // 通信失敗と、本当に対象が存在しない場合を区別する。
  if (!loadFailed && !venue) notFound();

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/venues" className="text-link hover:underline">
              式場一覧
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="min-w-0 max-w-full break-all">
            {venue?.name ?? '式場の詳細・変更'}
          </li>
        </ol>
      </nav>

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
