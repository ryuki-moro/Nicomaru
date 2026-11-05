/** S02 式場登録画面（system_admin、Phase 2。4-3 S02）。 */
import { redirect } from 'next/navigation';

import { VenueForm } from '../VenueForm';
import { Breadcrumbs, homeCrumbFor } from '@/components/layout/Breadcrumbs';
import { getAppUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function VenueNewPage() {
  const user = await getAppUser();
  if (!user || user.role !== 'system_admin') redirect('/error?code=403');

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          homeCrumbFor(user.role),
          { label: '式場一覧', href: '/venues' },
          { label: '新規登録' },
        ]}
      />

      <h1 className="section-head">式場の新規登録</h1>
      <VenueForm />
    </div>
  );
}
