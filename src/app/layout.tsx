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
  themeColor: '#D4537E',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {children}
        {!true && <PwaRegistration />}
        <PerformanceReporter />
      </body>
    </html>
  );
}
