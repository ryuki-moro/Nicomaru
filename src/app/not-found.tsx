import type { Metadata } from 'next';

import { ErrorScreen } from '@/components/layout/ErrorScreen';

export const metadata: Metadata = { title: 'ページが見つかりません' };

/**
 * P04 エラーページの404経路（4-3 P04）。
 *
 * 存在しないURLや notFound() では App Router がこのファイルを描画するので、
 * /error?code=404 へ1往復リダイレクトさせず、同じ部品（ErrorScreen）で直接出す。
 */
export default function NotFound() {
  return (
    <ErrorScreen
      message={{
        heading: 'ページが見つかりません',
        signedIn: 'URLが変わったか、対象がすでに削除されている可能性があります。',
        signedOut:
          'URLが変わったか、対象がすでに削除されている可能性があります。' +
          'ログイン画面からお進みください。',
      }}
    />
  );
}
