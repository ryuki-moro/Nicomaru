import { getAppUser, type AppUser } from '@/lib/auth/session';
import { localD1 } from '@/lib/d1/mode';
import type { Metadata } from 'next';
import { RegisterForm } from './RegisterForm';
export const metadata: Metadata = { title: '初回登録', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';
/** P02の先読みは案内だけ。消費・宛先照合の最終判定はinitial-registerの原子処理に任せる。 */
export default async function RegisterPage({
  params,
}: {
  params: Promise<{
    token: string;
  }>;
}) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return <InvalidInvitation />;
  return <RegistrationContent token={token} user={await getAppUser()} />;
}
function RegistrationContent({ token, user }: { token: string; user: AppUser | null }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold text-text-primary">はじめての設定</h1>
        <p className="mt-1 text-label text-text-muted">
          あと少しで、おふたりの準備ページが使えるようになります。
        </p>
      </div>
      {user && (
        <div role="status" className="banner-info">
          {user.displayName}としてログイン中です。このURLのご本人が登録してください。
        </div>
      )}
      <div role="status" className="banner-info">
        <span>
          プランナーからお送りした招待URLです。挙式日やお名前などの情報は登録済みですので、ご連絡先だけご入力ください。パスワードの設定は不要です。
        </span>
      </div>
      {localD1() && (
        <a href="/dev/mailbox" target="_blank" rel="noopener noreferrer" className="btn-ghost">
          ローカル受信箱で確認コードを見る
        </a>
      )}
      <RegisterForm token={token} />
    </div>
  );
}
function InvalidInvitation() {
  return (
    <div className="space-y-4">
      <h1 className="section-head">有効期限が切れているか無効です</h1>
      <p>プランナーへ再発行をご依頼ください。</p>
    </div>
  );
}
