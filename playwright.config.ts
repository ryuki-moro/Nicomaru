import { defineConfig, devices } from '@playwright/test';

/**
 * E2E テスト（第11章）。主要画面フロー：
 *   ログイン → 案件登録〜宿題割当 → 招待 → 初回登録 → 提出 → 確認
 *
 * 実行には Supabase プロジェクト（またはローカルスタック）が必要なため、
 * 接続情報が無い環境では e2e/*.spec.ts 側で skip する。
 * 単体・RLS テスト（npm test）は環境に依存せず常に実行できる。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // 8-4 対応環境: スマートフォン縦画面での操作性を最優先とする
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: 'npm run dev',
        url: process.env.APP_BASE_URL ?? 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
