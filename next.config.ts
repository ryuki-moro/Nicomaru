import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 通常の開発サーバーと同時に確認できるよう生成物を分ける。
  distDir:
    process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_LOGIN_ENABLED === 'true'
      ? '.next-dev-admin'
      : '.next',
  // middlewareの転送先127.0.0.1をNext.jsがlocalhostへ書き換えないようにする。
  // ログインCookieと更新APIの同一Origin検証を、設定したURLで一致させる。
  skipMiddlewareUrlNormalize: true,
  // 型・Lint の失敗をビルドで握りつぶさない（12-2 テストゲート）
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Security-Policy', value: "default-src 'none'; script-src 'self'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
