import type { Metadata } from 'next';

import { normalizeNext } from '@/lib/auth/next';
import { getAppUser } from '@/lib/auth/session';

import { LoginLinkForm } from './LoginLinkForm';

// ログイン中かどうかで表示を変えるため常に動的に評価する
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'メールのリンクでログイン' };

/**
 * P01 ログイン（メールのログインリンクの着地画面）。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1 方針(1)／4-3 P01。
 * メールのリンクは `/login/link?next=<戻り先>#e=<メールアドレス>&c=<6桁コード>`（src/lib/auth/login-link.ts）。
 *
 * /login と違い、ログイン済みでもサーバー側でリダイレクトしない。
 * 共用端末でパートナーのリンクを開いたときに、黙って元のアカウントのまま進ませないため。
 * 誰としてログインするかを画面で確かめ、ボタンを押したときだけ検証する（LoginLinkForm）。
 */
export default async function LoginLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const destination = normalizeNext(next);
  const current = await getAppUser();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold text-text-primary">ログイン</h1>
        <p className="mt-1 text-label text-text-muted">
          メールのリンクからログインします。表示されたメールアドレスをご確認ください。
        </p>
      </div>

      <LoginLinkForm next={destination} currentEmail={current?.email ?? null} />
    </div>
  );
}
