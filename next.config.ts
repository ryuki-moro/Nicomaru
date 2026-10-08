import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // middlewareの転送先127.0.0.1をNext.jsがlocalhostへ書き換えないようにする。
  // ログインCookieと更新APIの同一Origin検証を、設定したURLで一致させる。
  skipMiddlewareUrlNormalize: true,
  // 型・Lint の失敗をビルドで握りつぶさない（12-2 テストゲート）
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
