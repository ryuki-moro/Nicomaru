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
import { Breadcrumbs, homeCrumbFor } from '@/components/layout/Breadcrumbs';
import { createdRoleLabelFor, usersLabelFor } from '@/components/layout/staffNavItems';
import { getAppUser } from '@/lib/auth/session';
import { ROLE_LABEL } from '@/lib/constants';
import { redirect } from 'next/navigation';
import { UserForm } from './UserForm';
export default async function UserCreatePage() {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'system_admin') redirect('/error?code=403');
  // 表4-19 の自動設定規則。ここでの表示はサーバー側の判定と同じ規則で作る
  const createdRole = user.role === 'admin' ? 'planner' : 'admin';
  let fixedVenueName: string | null = null;
  let venueOptions: {
    id: string;
    name: string;
  }[] = [];
  {
    const db = await (await import('@/lib/d1/runtime')).localDB();
    const staff = await import('@/lib/d1/staff');
    if (user.role === 'admin')
      fixedVenueName = (await staff.venueName(db, user.venueId)) ?? '所属式場';
    else venueOptions = await staff.listVenues(db);
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
