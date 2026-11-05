/**
 * U02 利用者登録画面（admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-19／6-3-1／6-3-5 表6-4。
 *   初期パスワードは発行せず、初回パスワード設定リンクを送る。
 *   利用者種別・所属式場は画面で選ばせない（サーバー側で決める）。
 *
 * 本画面が表示するのは「サーバー側で決まる値」の確認だけで、
 * 実際の role／venue_id は /api/admin/users が呼び出し元のロールから決める。
 */
import { redirect } from 'next/navigation';

import { Breadcrumbs, homeCrumbFor } from '@/components/layout/Breadcrumbs';
import { createdRoleLabelFor, usersLabelFor } from '@/components/layout/staffNavItems';
import { getAppUser } from '@/lib/auth/session';
import { ROLE_LABEL } from '@/lib/constants';
import { usingD1 } from '@/lib/d1/mode';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { UserForm } from './UserForm';

export default async function UserCreatePage() {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'system_admin') redirect('/error?code=403');

  // 表4-19 の自動設定規則。ここでの表示はサーバー側の判定と同じ規則で作る
  const createdRole = user.role === 'admin' ? 'planner' : 'admin';

  let fixedVenueName: string | null = null;
  let venueOptions: { id: string; name: string }[] = [];

  if (usingD1()) {
    const db = await (await import('@/lib/d1/runtime')).localDB();
    const staff = await import('@/lib/d1/staff');
    if (user.role === 'admin')
      fixedVenueName = (await staff.venueName(db, user.venueId)) ?? '所属式場';
    else venueOptions = await staff.listVenues(db);
  } else if (user.role === 'admin' && user.venueId) {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from('venues')
      .select('name')
      .eq('id', user.venueId)
      .maybeSingle();
    fixedVenueName = (data as { name: string } | null)?.name ?? '所属式場';
  } else {
    // system_admin は venue_id を持たないため、対象式場を選ぶ必要がある。
    // 本来は S02（式場登録・編集）から遷移する導線だが S01〜S03 は Phase 2 のため、
    // Phase 1 は利用中の式場一覧から選ぶ形で代替する（venues_select は system_admin に全件許可）。
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase
      .from('venues')
      .select('id, name')
      .eq('active', true)
      .order('name')
      .order('id');
    venueOptions = (data ?? []) as { id: string; name: string }[];
  }

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          homeCrumbFor(user.role),
          { label: usersLabelFor(user.role), href: '/users' },
          { label: `${createdRoleLabelFor(user.role)}の登録` },
        ]}
      />

      <h1 className="section-head">{createdRoleLabelFor(user.role)}の登録</h1>

      <UserForm
        roleLabel={ROLE_LABEL[createdRole]}
        fixedVenueName={fixedVenueName}
        venueOptions={venueOptions}
      />
    </div>
  );
}
