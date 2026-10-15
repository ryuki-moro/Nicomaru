/** OTP の通信障害からの再操作。送信 API は全件差し替え、実メール・DB は操作しない。 */
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const UNAVAILABLE = '現在、認証サービスに接続できません。少し待ってからもう一度お試しください';

test('認証サービスの接続失敗後、入力を保持してログインリンクの送信をやり直せる', async ({
  page,
}) => {
  const email = 'otp-retry@example.invalid';
  const submittedEmails: string[] = [];
  const unexpectedAuthRequests: string[] = [];

  // フローが変わっても、Supabase Auth や別の認証 API に実リクエストを送らない。
  await page.route(/\/auth\/v1\//, async (route) => {
    unexpectedAuthRequests.push(route.request().method());
    await route.abort();
  });
  await page.route('**/api/auth/**', async (route) => {
    unexpectedAuthRequests.push(new URL(route.request().url()).pathname);
    await route.abort();
  });
  await page.route('**/api/auth/otp-request', async (route) => {
    submittedEmails.push(route.request().postDataJSON().email);
    if (submittedEmails.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'SERVICE_UNAVAILABLE', message: UNAVAILABLE, details: [] },
        }),
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });

  await page.goto('/login');
  const emailInput = page.getByLabel('メールアドレス', { exact: true });
  const sendButton = page.getByRole('button', { name: 'ログインリンクを送信', exact: true });
  const codeInput = page.getByRole('group', { name: 'ワンタイムコード', exact: true });
  const failureAlert = page.getByRole('alert').filter({ hasText: UNAVAILABLE });
  await emailInput.fill(email);
  await sendButton.click();

  await expect(failureAlert).toHaveText(UNAVAILABLE);
  await expect(codeInput).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(emailInput).toHaveValue(email);
  await expect(emailInput).toBeEnabled();
  await expect(sendButton).toBeEnabled();
  expect(submittedEmails).toEqual([email]);

  await sendButton.click();

  await expect(codeInput).toBeVisible();
  await expect(codeInput.getByRole('textbox')).toHaveCount(6);
  await expect(page.getByRole('status')).toContainText(
    `${email} 宛にログインリンクと6桁のコードをお送りしました。`,
  );
  await expect(failureAlert).toHaveCount(0);
  await expect(emailInput).toHaveValue(email);
  await expect(emailInput).toBeDisabled();
  await expect(page.getByRole('button', { name: '認証してログイン', exact: true })).toBeEnabled();
  expect(submittedEmails).toEqual([email, email]);
  expect(unexpectedAuthRequests).toEqual([]);
});
