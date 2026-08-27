import type { Metadata } from 'next';

import { RegisterForm } from './RegisterForm';

export const metadata: Metadata = { title: '初回登録' };

/**
 * P02 初回登録画面（couple）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 P02（表4-12）／6-6-1「初回登録フロー」。
 *
 * トークンの検証はここでは行わない。
 * 検証と消費は単一の UPDATE ... RETURNING で原子的に行う必要があり（6-6-1）、
 * 表示のためだけに先読みすると「開いただけで消費される」「検証を二度書く」のどちらかになるため、
 * 画面は入力を受け取るだけにして /api/auth/initial-register に一本化する。
 *
 * 挙式日・新郎新婦氏名などの案件情報は招待トークンで案件に自動紐付くため入力しない（表4-12）。
 */
export default async function RegisterPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold text-text-primary">はじめての設定</h1>
        <p className="mt-1 text-label text-text-muted">
          あと少しで、おふたりの準備ページが使えるようになります。
        </p>
      </div>

      <div role="status" className="banner-info">
        <span>
          プランナーからお送りした招待URLです。挙式日やお名前などの情報は登録済みですので、
          ご連絡先だけご入力ください。パスワードの設定は不要です。
        </span>
      </div>

      <RegisterForm token={token} />
    </div>
  );
}
