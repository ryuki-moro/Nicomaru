import { redirect } from 'next/navigation';

import { CoupleNav } from '@/components/couple/CoupleNav';
import { AppHeader } from '@/components/layout/AppHeader';
import { getAppUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * 新郎新婦向け画面の外枠（4-3 全画面共通仕様）。
 * ヘッダーは最小構成とし、下部に主要導線（M01／M02／M04）を固定表示する。
 */
export default async function CoupleLayout({ children }: { children: React.ReactNode }) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'couple') redirect('/dashboard');

  return (
    <div className="min-h-dvh bg-bg pb-20">
      <AppHeader role={user.role} displayName={user.displayName} minimal />
      <main className="screen py-5">{children}</main>
      <CoupleNav />
    </div>
  );
}
