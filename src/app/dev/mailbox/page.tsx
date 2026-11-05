import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { demoMailbox } from '@/lib/d1/mode';
import { localDB } from '@/lib/d1/runtime';
import { readMailbox, requireMailbox } from '@/lib/d1/mailbox';

const KIND_LABEL = {
  otp: 'ログイン確認コード',
  notification: 'お知らせ',
  invitation: '招待のご案内',
  password: 'パスワード設定',
} as const;

export const dynamic = 'force-dynamic';
export const metadata = { title: '受信箱', referrer: 'no-referrer' as const };
export default async function LocalMailboxPage() {
  const demo = demoMailbox();
  const allowed = await requireMailbox(await headers()).then(
    () => true,
    () => false,
  );
  if (!allowed) notFound();
  const messages = await readMailbox(await localDB());
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="section-head">{demo ? 'デモ受信箱' : 'ローカル受信箱'}</h1>
      <p className="banner-info">
        {demo
          ? 'デモ中はメールを外部へ送らず、ここに保存します。確認コードとリンクは各利用者へ伝えてください。'
          : '外部送信は行っていない。このPCの模擬メールだけを表示する。'}
      </p>
      <a href="/dev/mailbox" className="btn-secondary">
        受信箱を更新
      </a>
      {messages.length === 0 && <p>受信したメールはまだない。</p>}
      {messages.map((mail) => (
        <article key={mail.id} className="card space-y-2">
          <h2>
            {KIND_LABEL[mail.kind]} / {mail.email ?? '宛先メール未設定'}
          </h2>
          <p>{mail.createdAt}</p>
          {mail.subject && <p>{mail.subject}</p>}
          {mail.text && <p className="whitespace-pre-wrap">{mail.text}</p>}
          {mail.code && (
            <p>
              確認コード: <strong className="text-title">{mail.code}</strong>
            </p>
          )}
          {mail.url && (
            <a className="btn-ghost" href={mail.url} referrerPolicy="no-referrer">
              {mail.kind === 'password' ? '設定リンクを開く' : '招待を開く'}
            </a>
          )}
          {mail.expiresAt && <p>有効期限: {mail.expiresAt}</p>}
        </article>
      ))}
    </main>
  );
}
