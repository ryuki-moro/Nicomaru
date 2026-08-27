import Link from 'next/link';

/**
 * 未ログインで到達できる画面（P01 ログイン／P02 初回登録／P03 パスワード再設定）の外枠。
 *
 * 正本: 基本設計書 Version 1.2 4-2「画面遷移の概要」
 *   「未ログイン状態：P01／P02／P03／P04 のみアクセス可能」
 *
 * 共通ヘッダーの「利用者種別・表示名／ログアウト」は未ログインでは出せないため、
 * ここではサービス名だけの最小構成にする（4-3 全画面共通仕様）。
 * スマートフォン縦画面での操作性を最優先とし、幅は couple 側画面と同じ max-w-phone に揃える。
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="border-b border-border-light bg-surface">
        <div className="mx-auto flex max-w-phone items-center justify-center px-screen py-3">
          <Link href="/login" className="text-logo font-bold text-text-primary">
            にこまる
          </Link>
        </div>
      </header>

      <main className="screen flex-1 py-6">{children}</main>

      <footer className="screen pb-6 pt-2">
        <p className="text-center text-caption text-text-muted">
          結婚式の準備を、ふたりとプランナーで。
        </p>
      </footer>
    </div>
  );
}
