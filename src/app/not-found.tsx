import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'ページが見つかりません' };

/**
 * P04 エラーページの404経路（4-3 P04）。
 *
 * 存在しないURLでは App Router がこのファイルを描画するので、
 * /error?code=404 へ1往復リダイレクトさせず直接同じ見た目を出す。
 * 見た目を app/error/page.tsx と共有できないのは、
 * page.tsx から default 以外を export すると Next.js の型検証が落ちるため。
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg">
      <div className="screen flex flex-col gap-4">
        <div className="card flex flex-col gap-2 text-center">
          <h1 className="text-title font-bold text-text-primary">ページが見つかりません</h1>
          <p className="text-label text-text-secondary">
            URLが変わったか、対象がすでに削除されている可能性があります。
            ログイン画面からお進みください。
          </p>
        </div>
        <Link href="/login" className="btn-primary text-center">
          ログイン画面へ戻る
        </Link>
      </div>
    </div>
  );
}
