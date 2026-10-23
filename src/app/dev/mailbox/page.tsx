import { headers } from 'next/headers';
import { localDB } from '@/lib/d1/runtime';
import { readMailbox, requireLocalMailbox } from '@/lib/d1/mailbox';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'ローカル受信箱', referrer: 'no-referrer' as const };
export default async function LocalMailboxPage() {
  requireLocalMailbox(await headers());
  const messages = await readMailbox(await localDB());
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="section-head">ローカル受信箱</h1>
      <p className="banner-info">
        メール・LINEの外部送信は行っていない。このPCの模擬メールだけを表示する。
      </p>
      <a href="/dev/mailbox" className="btn-secondary">
        受信箱を更新
      </a>
      {messages.length === 0 && <p>受信したメールはまだない。</p>}
      {messages.map((mail) => (
        <article key={mail.id} className="card space-y-2">
          <h2>
            {mail.kind === 'otp' ? 'ログイン確認コード' : '招待のご案内'} /{' '}
            {mail.email ?? '宛先メール未設定'}
          </h2>
          <p>{mail.createdAt}</p>
          {mail.code && (
            <p>
              確認コード: <strong className="text-title">{mail.code}</strong>
            </p>
          )}
          {mail.url && (
            <a className="text-link underline" href={mail.url} referrerPolicy="no-referrer">
              招待を開く
            </a>
          )}
          <p>有効期限: {mail.expiresAt}</p>
        </article>
      ))}
    </main>
  );
}
