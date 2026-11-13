import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  logging: process.env.NICOMARU_DB === 'd1-local' ? { incomingRequests: false } : undefined,
  serverExternalPackages: ['wrangler', 'better-auth'],
  // ファイル追跡はNode向けの入口だけを拾う。OpenNextはworkerd向けの入口で束ねるため明示する。
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/@better-auth/core/dist/**/*.mjs',
      './node_modules/@better-auth/utils/dist/**/*.mjs',
    ],
  },
  // 通常の開発サーバー・dev:d1・demo を同時に確認できるよう生成物を分ける。
  distDir:
    process.env.NICOMARU_DB !== 'd1-local'
      ? '.next'
      : process.env.NICOMARU_DEMO_LOGIN === 'true'
        ? '.next-demo'
        : '.next-d1',
  // middlewareの転送先127.0.0.1をNext.jsがlocalhostへ書き換えないようにする。
  // ログインCookieと更新APIの同一Origin検証を、設定したURLで一致させる。
  skipMiddlewareUrlNormalize: true,
  // npm run demo は発表で投影するため、開発中の目印（左下の N）を出さない。
  // 温めた画面・APIも捨てない（既定は60秒・5件で捨て、確定時の再コンパイルとHMRで画面遷移が消える）
  ...(process.env.NICOMARU_DEMO_LOGIN === 'true' && {
    devIndicators: false as const,
    onDemandEntries: { maxInactiveAge: 24 * 60 * 60 * 1000, pagesBufferLength: 100 },
  }),
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
