import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getDevAdminConfig, isLoopbackHost } from '@/lib/auth/dev-admin';
import { normalizeNext } from '@/lib/auth/next';
import { getAppUser, landingPathFor } from '@/lib/auth/session';

import { DevAdminLoginButton } from './DevAdminLoginButton';
import { LoginForm } from './LoginForm';

// セッションの有無で分岐するため常に動的に評価する
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'ログイン' };

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
  searchParams: Promise<{ next?: string; reset?: string; mode?: string }>;
}) {
  const { next, reset, mode } = await searchParams;
  // 戻り先はパスと許可キーのクエリだけ（src/lib/auth/next.ts）。不正なら役割別の初期画面へ
  const destination = normalizeNext(next);
  const destinationPath = destination?.split('?')[0];
  // 式場管理へのリンクでは、管理者が使うパスワード入力を最初から表示する。
  // 方式の選択だけであり、認証・認可は通常の経路で行う。
  const isVenueDestination =
    destinationPath === '/venues' || destinationPath?.startsWith('/venues/');
  const initialMode = mode === 'password' || isVenueDestination ? 'password' : 'otp';

  // ログイン済みで /login を開いた場合は種別ごとの初期画面へ戻す（4-2）
  const user = await getAppUser();
  if (user) redirect(destination ?? landingPathFor(user.role));

  const host = (await headers()).get('host') ?? '';
  const showDevAdmin = Boolean(getDevAdminConfig()) && isLoopbackHost(host);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold text-text-primary">ログイン</h1>
        <p className="mt-1 text-label text-text-muted">
          {process.env.NICOMARU_DB === 'd1-local'
            ? '新郎新婦は確認コード、プランナー・管理者はパスワードでログインできます。'
            : initialMode === 'password'
              ? 'プランナー・管理者はメールアドレスとパスワードでログインしてください。'
              : '新郎新婦さまはメールアドレスだけでログインできます。'}
        </p>
      </div>

      {reset === 'done' && (
        <div role="status" className="banner-info">
          <span>パスワードの設定が完了しました。新しいパスワードでログインしてください。</span>
        </div>
      )}

      {showDevAdmin && <DevAdminLoginButton />}
      {process.env.NICOMARU_DB === 'd1-local' && (
        <a href="/dev/mailbox" target="_blank" rel="noopener noreferrer" className="btn-ghost">
          ローカル受信箱で確認コードを見る
        </a>
      )}
      <LoginForm next={destination} initialMode={initialMode} />
    </div>
  );
}
