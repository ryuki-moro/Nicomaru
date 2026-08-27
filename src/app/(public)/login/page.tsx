import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getAppUser, landingPathFor } from '@/lib/auth/session';

import { LoginForm } from './LoginForm';

// セッションの有無で分岐するため常に動的に評価する
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'ログイン' };

/** オープンリダイレクト防止。自サイト内の絶対パスだけを許可する。 */
function safeNext(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

/**
 * P01 ログイン画面（全利用者）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 P01（表4-11）／6-3-1「認証方式」。
 *   - couple: ワンタイム認証（マジックリンク＋6桁コード）
 *   - planner／admin／system_admin: メールアドレス＋パスワード
 *   - 認証成功時の遷移先は landingPathFor(role)（4-2）
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string }>;
}) {
  const { next, reset } = await searchParams;
  const destination = safeNext(next);

  // ログイン済みで /login を開いた場合は種別ごとの初期画面へ戻す（4-2）
  const user = await getAppUser();
  if (user) redirect(destination ?? landingPathFor(user.role));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold text-text-primary">ログイン</h1>
        <p className="mt-1 text-label text-text-muted">
          新郎新婦さまはメールアドレスだけでログインできます。
        </p>
      </div>

      {reset === 'done' && (
        <div role="status" className="banner-info">
          <span>パスワードの設定が完了しました。新しいパスワードでログインしてください。</span>
        </div>
      )}

      <LoginForm next={destination} />
    </div>
  );
}
