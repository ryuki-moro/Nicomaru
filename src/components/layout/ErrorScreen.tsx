/**
 * P04 エラーページの見た目と出口（4-3 P04）。app/error/page.tsx と app/not-found.tsx で共有する。
 *
 * 出口のボタンはログイン状態で変える。
 *   - ログイン中（active）… そのロールの着地点（landingPathFor）へ戻る
 *   - それ以外            … ログイン画面へ戻る（4-3 P04 の既定）
 * ログイン中に「ログイン画面へ戻る」だけを出すと、/login が着地点へ送り返すので
 * 押しても前に進めず、出口がなくなっていた（docs/ui-review/p2 高-3）。
 *
 * page.tsx から default 以外を export できない（Next.js の型検証）ため、ページではなく部品として置く。
 */
import Link from 'next/link';

import { CoupleNav } from '@/components/couple/CoupleNav';
import { AppHeader } from '@/components/layout/AppHeader';
import { landingLabelFor, landingPathFor, resolveAppUser } from '@/lib/auth/session';
import { isStaff } from '@/lib/constants';

export interface ErrorMessage {
  heading: string;
  /** ログイン中の人に出す説明 */
  signedIn: string;
  /** 未ログイン・利用できない状態の人に出す説明 */
  signedOut: string;
}

export async function ErrorScreen({ message }: { message: ErrorMessage }) {
  const resolved = await resolveAppUser();
  const user = resolved.state === 'active' ? resolved.user : null;

  const content = (
    <div className="flex flex-col gap-4">
      <div className="card flex flex-col gap-2 text-center">
        <h1 className="text-title font-bold text-text-primary">{message.heading}</h1>
        {/* 要件: 責められていると感じさせず、次の操作が分かる文言にする */}
        <p className="text-label text-text-secondary">
          {user ? message.signedIn : message.signedOut}
        </p>
      </div>
      {user ? (
        <Link href={landingPathFor(user.role)} className="btn-primary text-center">
          {landingLabelFor(user.role)}へ戻る
        </Link>
      ) : (
        <Link href="/login" className="btn-primary text-center">
          ログイン画面へ戻る
        </Link>
      )}
    </div>
  );

  // App Router の not-found / P04 は通常の staff・couple layout の外で描画される
  // 場合があるため、認証済みならここで利用者のナビを含む共通外枠を再現する。
  if (user && isStaff(user.role)) {
    return (
      <div className="min-h-dvh bg-bg">
        <AppHeader role={user.role} displayName={user.displayName} />
        <main className="mx-auto w-full max-w-6xl px-4 py-6">
          <div className="mx-auto w-full max-w-2xl">{content}</div>
        </main>
      </div>
    );
  }

  if (user) {
    return (
      <div className="min-h-dvh bg-bg pb-20">
        <AppHeader role={user.role} displayName={user.displayName} minimal />
        <main className="screen py-5">{content}</main>
        <CoupleNav />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg">
      <div className="screen">{content}</div>
    </div>
  );
}
