import { redirect } from 'next/navigation';

import { getAppUser, landingPathFor } from '@/lib/auth/session';

// セッションに依存するため常に動的に評価する
export const dynamic = 'force-dynamic';

/** ログイン後の初期遷移先へ振り分ける（4-2）。 */
export default async function RootPage() {
  const user = await getAppUser();
  redirect(user ? landingPathFor(user.role) : '/login');
}
