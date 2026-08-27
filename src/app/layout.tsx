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
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#D4537E',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
