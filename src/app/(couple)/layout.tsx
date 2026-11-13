import { redirect } from 'next/navigation';

import { CoupleNav } from '@/components/couple/CoupleNav';
import { AppHeader } from '@/components/layout/AppHeader';
import { getAppUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * 新郎新婦向け画面の外枠（4-3 全画面共通仕様）。
 * ヘッダーは最小構成とし、下部に主要導線（M01／M02／M04）を固定表示する。
 *
 * 幅は 360px（max-w-phone）が基本。入力系の画面（提出フォームなど）は、メールからPCで開くと
 * 両側が大きく空いて入力欄も狭いので、PC幅（sm 以上）でだけ 560px に広げる。
 * 広げたい画面は、ページのどこかに data-wide-form を付ける。ここで :has() によりそれを見つけ、
 * max-w-phone が参照する --screen-width を切り替えるので、ヘッダー・本文・下部ナビの幅が一緒に変わる。
 * スマートフォン幅では変数を変えないため、表示はこれまでと変わらない。
 */
export default async function CoupleLayout({ children }: { children: React.ReactNode }) {
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'couple') redirect('/dashboard');

  return (
    <div className="min-h-dvh bg-bg pb-20 sm:has-[[data-wide-form]]:[--screen-width:560px]">
      <AppHeader role={user.role} displayName={user.displayName} minimal />
      <main className="screen py-5">{children}</main>
      <CoupleNav />
    </div>
  );
}
