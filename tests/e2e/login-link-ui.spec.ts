/** 着地画面の異常系。認証APIを差し替え、実メール・DBは操作しない。 */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('別コンテキストでリンクを開いても、押下まで検証せず指定の画面へ戻る', async ({ browser }) => {
  const receiver = await browser.newContext();
  const page = await receiver.newPage();
  const destination = '/mypage/tasks?tab=needs_fix';
  const verified: unknown[] = [];
  await page.route('**/auth/v1/**', (route) => route.abort());
  await page.route('**/api/auth/**', (route) => route.abort());
  await page.route('**/api/auth/otp-verify', async (route) => {
    verified.push(route.request().postDataJSON());
    await route.fulfill({ json: { redirectTo: '/mypage' } });
  });
  await page.route('**/mypage/tasks**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>復帰先</h1>' }),
  );
  try {
    await page.goto(
      `/login/link?next=${encodeURIComponent(destination)}#e=other%2Bbrowser%40example.test&c=123456`,
    );
    await expect(page.getByText('other+browser@example.test でログインします。')).toBeVisible();
    await expect(page).toHaveURL(/\/login\/link\?next=[^#]+$/);
    expect(verified).toEqual([]);
    await page.getByRole('button', { name: 'ログインする', exact: true }).click();
    await page.waitForURL((url) => `${url.pathname}${url.search}` === destination);
    await expect(page.getByRole('heading', { name: '復帰先' })).toBeVisible();
    expect(verified).toEqual([{ email: 'other+browser@example.test', code: '123456' }]);
  } finally {
    await receiver.close();
  }
});

test('欠損したコードでも読み取ったメールを保持して再送できる', async ({ page }) => {
  await page.goto('/login/link#e=retry%40example.test&c=invalid');
  await expect(page.getByLabel('メールアドレス', { exact: true })).toHaveValue(
    'retry@example.test',
  );
  await expect(page.getByLabel('メールアドレス', { exact: true })).toBeEditable();
  await expect(page).toHaveURL(/\/login\/link$/);
});

test('期限切れ応答後にメールと戻り先を保持して再送できる', async ({ page }) => {
  const email = 'expired-link@example.test';
  const next = '/mypage/tasks?tab=needs_fix';
  const verified: unknown[] = [];
  const requested: unknown[] = [];
  await page.route('**/api/auth/**', (route) => route.abort());
  await page.route('**/api/auth/otp-verify', async (route) => {
    verified.push(route.request().postDataJSON());
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNPROCESSABLE', message: '有効期限が切れています', details: [] },
      }),
    });
  });
  await page.route('**/api/auth/otp-request', async (route) => {
    requested.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto(
    `/login/link?next=${encodeURIComponent(next)}#e=${encodeURIComponent(email)}&c=123456`,
  );
  const login = page.getByRole('button', { name: 'ログインする', exact: true });
  await expect(login).toBeVisible();
  expect(verified).toEqual([]);
  await expect(page).toHaveURL(/\/login\/link\?next=[^#]+$/);
  await login.click();
  await expect(page.getByRole('alert').filter({ hasText: '有効期限が切れています' })).toBeVisible();
  await expect(page.getByLabel('メールアドレス', { exact: true })).toHaveValue(email);
  await expect(page.getByLabel('メールアドレス', { exact: true })).toBeEditable();
  await page.getByRole('button', { name: 'ログインリンクを送信', exact: true }).click();
  await expect(page.getByRole('group', { name: 'ワンタイムコード' })).toBeVisible();
  expect(verified).toEqual([{ email, code: '123456' }]);
  expect(requested).toEqual([{ email, next }]);
});

test('検証中はボタンを無効にし、失敗後は再入力できる', async ({ page }) => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let requests = 0;
  await page.route('**/api/auth/**', (route) => route.abort());
  await page.route('**/api/auth/otp-verify', async (route) => {
    requests++;
    await pending;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'SERVICE_UNAVAILABLE', message: '接続できません', details: [] },
      }),
    });
  });
  try {
    await page.goto('/login/link#e=retry%40example.test&c=123456');
    const login = page.getByRole('button', { name: 'ログインする', exact: true });
    await login.click();
    await expect(login).toBeDisabled();
    await expect.poll(() => requests).toBe(1);
    finish!();
    await expect(page.getByLabel('メールアドレス', { exact: true })).toHaveValue(
      'retry@example.test',
    );
    await expect(
      page.getByRole('button', { name: 'ログインリンクを送信', exact: true }),
    ).toBeEnabled();
  } finally {
    finish?.();
  }
});

test('旧形式リンクの失敗後もメールと6桁コードを入力できる', async ({ page }) => {
  await page.route('**/auth/v1/**', (route) => route.abort());
  await page.route('**/api/auth/**', (route) => route.abort());
  await page.goto('/login?error_description=expired');
  const email = page.getByLabel('メールアドレス', { exact: true });
  await expect(email).toBeEditable();
  await email.fill('legacy@example.test');
  await expect(page.getByRole('group', { name: 'ワンタイムコード' })).toBeVisible();
  await expect(page.getByLabel('ワンタイムコード 1桁目')).toBeEditable();
});

test('旧形式のcode交換失敗後もメールを入力し直せる', async ({ page }) => {
  await page.route('**/auth/v1/**', (route) => route.abort());
  await page.route('**/api/auth/**', (route) => route.abort());
  await page.goto('/login?code=expired-code');
  await expect(page.getByLabel('メールアドレス', { exact: true })).toBeEditable();
  await expect(page.getByRole('group', { name: 'ワンタイムコード' })).toBeVisible();
  await expect(page.getByLabel('ワンタイムコード 1桁目')).toBeEditable();
});
