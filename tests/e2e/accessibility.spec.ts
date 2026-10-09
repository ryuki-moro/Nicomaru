/** 実メール・Auth要求を止め、主要ログイン導線をキーボードで検証する。 */
import { expect, test } from '@playwright/test';

// 通信差し替えがSW経由で回避されないよう、この模擬試験だけ登録を止める。
test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ page }) => {
  await page.route(/\/auth\/v1\//, (route) => route.abort());
  await page.route('**/api/auth/**', (route) => route.abort());
});

test('ログインのラベル・Tab順・フォーカス・項目エラーを確認できる', async ({ page }) => {
  await page.route('**/api/auth/otp-request', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'VALIDATION_ERROR',
          message: '入力内容をご確認ください',
          details: [{ field: 'email', reason: 'メールアドレスを確認してください' }],
        },
      }),
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  const email = page.getByRole('textbox', { name: 'メールアドレス', exact: true });
  await page.getByRole('link', { name: 'にこまる', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(email).toBeFocused();
  expect(await email.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  await email.fill('keyboard@example.invalid');
  await page.keyboard.press('Tab');
  const submit = page.getByRole('button', { name: 'ログインリンクを送信', exact: true });
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('alert').filter({ hasText: '入力内容をご確認ください' }),
  ).toBeVisible();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAccessibleDescription('メールアドレスを確認してください');
  const box = await submit.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('パスワード方式への切替と入力をキーボードだけで操作できる', async ({ page }) => {
  await page.goto('/login');
  const switchMode = page.getByRole('button', {
    name: 'パスワードでログイン（プランナー・管理者）',
    exact: true,
  });
  await switchMode.focus();
  await page.keyboard.press('Enter');
  const email = page.getByLabel('メールアドレス', { exact: true });
  const password = page.getByLabel('パスワード', { exact: true });
  await email.focus();
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await password.fill('test-only-not-submitted');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'パスワードでログイン', exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
