/** 戻り先のUI検証。認証APIと復帰先の応答を差し替え、実メール・DBは操作しない。 */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const mode of ['otp', 'password'] as const) {
  test(`${mode}認証後も元のパス・タブ・ページを保持し、機微クエリを捨てる`, async ({ page }) => {
    const destination = '/mypage/tasks?tab=needs_fix&page=2';
    let authenticated = false;
    const requests: { path: string; body: Record<string, unknown> }[] = [];

    await page.route('**/auth/v1/**', (route) => route.abort());
    await page.route('**/api/auth/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push({ path, body: route.request().postDataJSON() });
      if (path === '/api/auth/otp-request') {
        await route.fulfill({ status: 204 });
      } else if (path === `/api/auth/${mode === 'otp' ? 'otp-verify' : 'password-login'}`) {
        authenticated = true;
        await route.fulfill({ json: { redirectTo: '/mypage' } });
      } else {
        throw new Error(`予期しない認証API: ${path}`);
      }
    });
    await page.route('**/mypage/tasks**', async (route) => {
      if (authenticated) {
        await route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<meta charset="utf-8"><h1>復帰先</h1>',
        });
      } else {
        await route.continue();
      }
    });

    await page.goto(`${destination}&token=private-value&code=private-code&linkToken=private-link`);
    await page.waitForURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(destination);
    expect(page.url()).not.toContain('private-');
    if (mode === 'password') {
      await page
        .getByRole('button', { name: 'パスワードでログイン（プランナー・管理者）', exact: true })
        .click();
    }
    await page.getByLabel('メールアドレス', { exact: true }).fill('return@example.test');

    if (mode === 'otp') {
      await page.getByRole('button', { name: 'ログインリンクを送信', exact: true }).click();
      await expect(page.getByRole('group', { name: 'ワンタイムコード' })).toBeVisible();
      expect(requests[0]).toEqual({
        path: '/api/auth/otp-request',
        body: { email: 'return@example.test', next: destination },
      });
      await page.getByLabel('ワンタイムコード 1桁目', { exact: true }).click();
      await page.keyboard.type('123456');
    } else {
      await page.getByLabel('パスワード', { exact: true }).fill('Test-only-password1!');
      await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
    }

    await page.waitForURL((url) => `${url.pathname}${url.search}` === destination);
    await expect(page.getByRole('heading', { name: '復帰先' })).toBeVisible();
    expect(requests.at(-1)?.path).toBe(
      `/api/auth/${mode === 'otp' ? 'otp-verify' : 'password-login'}`,
    );
  });
}

test('外部URLのnextは送信要求へ持ち込まない', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/auth/v1/**', (route) => route.abort());
  await page.route('**/api/auth/otp-request', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });
  await page.goto('/login?next=https%3A%2F%2Fevil.example.test');
  await page.getByLabel('メールアドレス', { exact: true }).fill('return@example.test');
  await page.getByRole('button', { name: 'ログインリンクを送信', exact: true }).click();
  await expect(page.getByRole('group', { name: 'ワンタイムコード' })).toBeVisible();
  expect(submitted).toEqual({ email: 'return@example.test' });
});
