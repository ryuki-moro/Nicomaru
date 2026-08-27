import { redirect } from 'next/navigation';

import { AppHeader } from '@/components/layout/AppHeader';
import { getAppUser } from '@/lib/auth/session';
import { isStaff } from '@/lib/constants';

export const dynamic = 'force-dynamic';

/** planner／admin／system_admin 向け画面の外枠。パンくずは各画面が自前で描画する（4-3）。 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (!isStaff(user.role)) redirect('/mypage');

  return (
    <div className="min-h-dvh bg-bg">
      <AppHeader role={user.role} displayName={user.displayName} />
      <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
