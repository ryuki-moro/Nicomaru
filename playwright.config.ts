import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E テスト（第11章／12-2、Issue #19）。主要画面フロー：
 *   ログイン → 案件登録〜宿題割当 → 招待 → 初回登録 → 提出 → 確認
 *
 * 実行には Supabase プロジェクト（またはローカルスタック `supabase start`）が必要なため、
 * 接続情報が無い環境では tests/e2e/*.spec.ts 側で skip する。
 * 単体・RLS テスト（npm test）は環境に依存せず常に実行できる。
 *
 * 手元での実行手順は tests/e2e/README.md。
 */

// ローカルでは .env.local の値をそのまま使う（Next.js が読むのと同じファイル）。
// テストプロセスは Next.js を経由しないので、ここで読み込む。既に設定済みの値は上書きしない。
if (!process.env.CI && existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^"(.*)"$/, '$1');
  }
}

const baseURL = process.env.APP_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // 通し（案件登録〜確認）は1本で数十秒かかる
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // 8-4 対応環境: スマートフォン縦画面での操作性を最優先とする
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        // CI ではビルド済みを起動する（本番と同じ経路）。手元は dev サーバーでよい
        command: process.env.CI ? 'npm run start' : 'npm run dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
