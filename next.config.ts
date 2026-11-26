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
  // デモは起動時に主な画面を先にコンパイルする（scripts/d1-local.mjs）。
  // 既定では60秒・5画面で捨てられ、発表中に再コンパイルを待つため保持し続ける。
  ...(process.env.NICOMARU_DEMO_LOGIN === 'true' && {
    onDemandEntries: { maxInactiveAge: 24 * 60 * 60 * 1000, pagesBufferLength: 100 },
  }),
  // middlewareの転送先127.0.0.1をNext.jsがlocalhostへ書き換えないようにする。
  // ログインCookieと更新APIの同一Origin検証を、設定したURLで一致させる。
  skipMiddlewareUrlNormalize: true,
  // npm run demo は発表で投影するため、開発中の目印（左下の N）を出さない
  ...(process.env.NICOMARU_DEMO_LOGIN === 'true' && { devIndicators: false as const }),
  webpack: (config, { dev, isServer, nextRuntime }) => {
    // 開発時のサーバー側は node_modules をパッケージ単位の1ファイル(next は 7MB 超)に束ね、
    // 画面を初めて開くたびに書き直す。Windows Defender は書き直された大きなファイルを
    // 読み込み時に同期で検査するため、そのたびに十数秒止まる。3階層下のフォルダ単位に分け、
    // 書き直す量を小さくする。
    const vendor = config.optimization?.splitChunks?.cacheGroups?.vendor;
    if (dev && isServer && nextRuntime === 'nodejs' && vendor) {
      const packageName = vendor.name;
      vendor.name = (module: { nameForCondition(): string | null }, ...rest: unknown[]) => {
        const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](.*)$/.exec(
          module.nameForCondition() ?? '',
        );
        if (!match) return packageName(module, ...rest);
        const dirs = match[2].split(/[\\/]/).slice(0, -1).slice(0, 3);
        return ['vendor-chunks/' + match[1].replace(/[\\/]/, '+'), ...dirs].join('-');
      };
    }
    // 開発サーバーを複数同時に動かすと、互いの生成物やローカルDBの書込みで再コンパイルが続く。
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
