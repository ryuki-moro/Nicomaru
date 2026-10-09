import { expect, test } from '@playwright/test';

// 既存のアカウントを変更せず、dev:admin ランチャーが準備した専用adminで検証する。
test.skip(process.env.E2E_DEV_ADMIN_MODE !== 'true', 'dev:admin の専用サーバーが必要です');
if (process.env.E2E_BROWSER_CHANNEL === 'chrome') test.use({ browserName: 'chromium', channel: 'chrome' });

test('入力省略で管理画面に入り、再読み込みとログアウトができる', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: '開発用adminで入る', exact: true }).click();
  await page.waitForURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  await expect(page.getByText('式場管理者 / 開発用admin', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible();
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: '利用者管理', exact: true })).toBeVisible();
  expect((await page.request.get('/api/admin/users')).status()).toBe(200);
  await page.goto('/templates');
  await expect(page.getByRole('heading', { name: '宿題テンプレート', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await page.waitForURL(/\/login/);
  await page.goto('/dashboard');
  await page.waitForURL(/\/login\?next=%2Fdashboard$/);
  const response = await page.request.get('/api/admin/users');
  expect(response.status()).toBe(401);
  await expect(page.getByRole('button', { name: '開発用adminで入る', exact: true })).toBeVisible();
});

test('専用APIはGET・Originなし・別Originを拒否する', async ({ request, baseURL }) => {
  expect((await request.get('/api/auth/dev-admin')).status()).toBe(405);
  expect((await request.post('/api/auth/dev-admin', { data: {} })).status()).toBe(403);
  const denied = await request.post('/api/auth/dev-admin', {
    data: {}, headers: { origin: 'https://evil.test' },
  });
  expect(denied.status()).toBe(403);
  expect(denied.headers()['set-cookie']).toBeUndefined();
  const accepted = await request.post('/api/auth/dev-admin', {
    data: {}, headers: { origin: baseURL! },
  });
  expect(accepted.status()).toBe(200);
  expect(await accepted.json()).toEqual({ redirectTo: '/dashboard' });
});
