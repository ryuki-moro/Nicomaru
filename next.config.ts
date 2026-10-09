import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 通常の開発サーバーと同時に確認できるよう生成物を分ける。
  distDir: process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_LOGIN_ENABLED === 'true'
    ? '.next-dev-admin' : '.next',
  // 型・Lint の失敗をビルドで握りつぶさない（12-2 テストゲート）
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
