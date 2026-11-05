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

import { landingLabelFor, landingPathFor, resolveAppUser } from '@/lib/auth/session';

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

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg">
      <div className="screen flex flex-col gap-4">
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
    </div>
  );
}
