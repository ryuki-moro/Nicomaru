/** S02 式場登録画面（system_admin、Phase 2。4-3 S02）。 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { VenueForm } from '../VenueForm';
import { getAppUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function VenueNewPage() {
  const user = await getAppUser();
  if (!user || user.role !== 'system_admin') redirect('/error?code=403');

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/venues" className="text-link hover:underline">式場一覧</Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">新規登録</li>
        </ol>
      </nav>

      <h1 className="section-head">式場の新規登録</h1>
      <VenueForm />
    </div>
  );
}
