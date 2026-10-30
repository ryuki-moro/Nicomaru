import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  logging: process.env.NICOMARU_DB === 'd1-local' ? { incomingRequests: false } : undefined,
  serverExternalPackages: ['wrangler', 'better-auth'],
  // 通常の開発サーバーと同時に確認できるよう生成物を分ける。
  distDir:
    process.env.NICOMARU_DB === 'd1-local'
      ? '.next-d1'
      : process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_LOGIN_ENABLED === 'true'
        ? '.next-dev-admin'
        : '.next',
  // middlewareの転送先127.0.0.1をNext.jsがlocalhostへ書き換えないようにする。
  // ログインCookieと更新APIの同一Origin検証を、設定したURLで一致させる。
  skipMiddlewareUrlNormalize: true,
  // 開発サーバーを複数同時に動かすと、互いの生成物やローカルDBの書込みで再コンパイルが続く。
  webpack: (config, { dev }) => {
    if (dev)
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next*/**',
          '**/.wrangler/**',
          '**/.work/**',
        ],
      };
    return config;
  },
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
        source: '/register/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
      {
        source: '/dev/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
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
