import { PerformanceReporter } from '@/components/PerformanceReporter';
import { PwaRegistration } from '@/components/PwaRegistration';
import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: {
    default: 'にこまる | BridalHub',
    template: '%s | にこまる',
  },
  description: '結婚式の準備を、プランナーと新郎新婦がひとつの画面で進めるための進行管理アプリ。',
  // PWA として利用する（要件 3-2／2-2）
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'にこまる' },
  icons: { icon: '/icons/icon.svg', apple: '/icons/apple-touch-icon.png' },
  // 端末（iOS の Dynamic Type など）の文字サイズ設定を 1rem に反映させる。
  // 文字サイズは tailwind.config.ts で rem 指定にしてあるので、画面全体が一緒に拡大する
  other: { 'text-scale': 'scale' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // アプリアイコン（public/icons/icon.svg）と同じ色。manifest の theme_color とそろえる
  themeColor: '#D4537E',
  // CSS（globals.css の color-scheme）より先に、読み込み直後の背景もライトにする
  colorScheme: 'light',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {children}
        {/* 開発サーバー（npm run dev:d1 など）では登録しない。古い Service Worker が残って
            再コンパイル後の画面と食い違うのを避ける。本番ビルドではホーム画面追加のために登録する */}
        {process.env.NODE_ENV === 'production' && <PwaRegistration />}
        <PerformanceReporter />
      </body>
    </html>
  );
}
