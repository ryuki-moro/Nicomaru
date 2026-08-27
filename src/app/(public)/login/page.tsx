import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getAppUser, landingPathFor } from '@/lib/auth/session';

import { LoginForm } from './LoginForm';

// セッションの有無で分岐するため常に動的に評価する
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'ログイン' };

/**
 * 遷移先として許可する ?next= の形。
 *
 *   ^\/                       自サイト内の絶対パスに限る（'https://…' や 'javascript:' を弾く）
 *   (?![/\\])                 2文字目が '/' でも '\' でもないこと
 *   [^\u0000-\u001F\u007F\\]* 以降にバックスラッシュと制御文字を含まないこと
 *
 * '//' だけを見る判定では '/\evil.com' が素通りする。ブラウザは URL のパス区切りで
 * '\' を '/' と同一視するため、これを protocol-relative URL（'//evil.com'）として解釈し、
 * 外部サイトへ遷移してしまう。P01 の couple はパスワードを持たず、メールと6桁コードだけで
 * ログインする（6-3-1）ので、偽のログイン画面へ誘導されること自体がアカウント奪取に直結する。
 * 制御文字（改行・タブ・NUL）も、遷移先の見た目を偽装したりヘッダを分割したりする材料に
 * なるため同時に弾く。条件を複数の startsWith に分けると取りこぼしが生まれるので、1本にまとめる。
 */
const SAFE_NEXT_PATTERN = /^\/(?![/\\])[^\u0000-\u001F\u007F\\]*$/;

/** オープンリダイレクト防止。自サイト内の絶対パスだけを許可する（12-1）。 */
function safeNext(next: string | undefined): string | null {
  if (!next) return null;
  return SAFE_NEXT_PATTERN.test(next) ? next : null;
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
