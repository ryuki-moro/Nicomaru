/**
 * U03 利用者変更画面（U04 削除確認を含む・admin／system_admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-20／U04 の記述。
 *
 * /api/admin/users/{userId} へ送る（Auth Admin API が必要なため。6-3-5 表6-4）。
 * ここでの管理範囲チェックは導線を正すためのもので、実際の防御は API 層と RLS が担う。
 */
import { Breadcrumbs, homeCrumbFor } from '@/components/layout/Breadcrumbs';
import { usersLabelFor } from '@/components/layout/staffNavItems';
import { getAppUser, type AppUser } from '@/lib/auth/session';
import { ROLE_LABEL, type Role, type UserStatus } from '@/lib/constants';
import { ApiError } from '@/lib/errors';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { UserEditForm, type SuccessorOption } from './UserEditForm';
interface ProfileRow {
  id: string;
  display_name: string;
  email: string;
  phone: string | null;
  role: Role;
  status: UserStatus;
  venue_id: string | null;
}
export default async function UserEditPage({
  params,
}: {
  params: Promise<{
    userId: string;
  }>;
}) {
  const { userId } = await params;
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin' && user.role !== 'system_admin') redirect('/error?code=403');
  {
    const db = await (await import('@/lib/d1/runtime')).localDB();
    const staff = await import('@/lib/d1/staff');
    const target = await staff.managedStaff(db, user, userId).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') notFound();
      throw error;
    });
    const { assignedCaseCount, successors } = await staff.handoverOptions(db, target);
    return (
      <UserEditView
        user={user}
        target={target}
        venueName={target.venue_name}
        assignedCaseCount={assignedCaseCount}
        successorOptions={assignedCaseCount > 0 ? successors : []}
      />
    );
  }
}
function UserEditView({
  user,
  target,
  venueName,
  assignedCaseCount,
  successorOptions,
}: {
  user: AppUser;
  target: ProfileRow;
  venueName: string | null;
  assignedCaseCount: number;
  successorOptions: SuccessorOption[];
}) {
  // 削除済みは変更対象にしない（5-1 削除方針の論理削除）
  const isDeleted = target.status === 'deleted';
  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          homeCrumbFor(user.role),
          { label: usersLabelFor(user.role), href: '/users' },
          { label: target.display_name },
        ]}
      />

      <h1 className="section-head">利用者の変更：{target.display_name}</h1>

      {isDeleted ? (
        <div className="card space-y-3">
          <p className="banner-info">
            この利用者は削除済みです。記録は残りますが、変更やログインはできません。
          </p>
          <Link href="/users" className="btn-secondary block text-center">
            一覧に戻る
          </Link>
        </div>
      ) : (
        <UserEditForm
          userId={target.id}
          roleLabel={ROLE_LABEL[target.role]}
          venueName={venueName ?? '未設定'}
          initial={{
            displayName: target.display_name,
            email: target.email,
            phone: target.phone ?? '',
            // deleted は上で分岐済みのため、ここに来る値は表4-20 の3種類だけ
            status: target.status as 'active' | 'invited' | 'suspended',
          }}
          isSelf={target.id === user.id}
          assignedCaseCount={assignedCaseCount}
          successorOptions={successorOptions}
        />
      )}
    </div>
  );
}
