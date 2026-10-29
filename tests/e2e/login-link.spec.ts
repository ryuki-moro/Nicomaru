import { expect, test, type BrowserContext } from '@playwright/test';

import { createPlanner } from './helpers/admin';
import { hasE2eEnv } from './helpers/env';
import { loginAsPlanner } from './helpers/flows';
import { waitForOtpMail } from './helpers/mail';

test.skip(!hasE2eEnv, 'ローカル Supabase と Mailpit の接続情報が必要');

async function requestLink(context: BrowserContext, baseURL: string, email: string) {
  const after = new Date();
  const response = await context.request.post(`${baseURL}/api/auth/otp-request`, {
    headers: { Origin: new URL(baseURL).origin },
    data: { email, next: '/dashboard?tab=all' },
  });
  expect(response.status()).toBe(204);
  const mail = await waitForOtpMail(email, { after });
  const link = mail.links.find((href) => new URL(href).pathname === '/login/link');
  expect(link).toBeDefined();
  const url = new URL(link!);
  expect(url.origin).toBe(new URL(baseURL).origin);
  expect(url.searchParams.get('next')).toBe('/dashboard?tab=all');
  const fragment = new URLSearchParams(url.hash.slice(1));
  expect(fragment.get('e')).toBe(email);
  expect(fragment.get('c')).toBe(mail.code);
  return link!;
}

test('別ブラウザで開くだけでは消費せず、押下後に復帰し、使用済みは再送できる', async ({
  browser,
  baseURL,
}) => {
  const account = await createPlanner();
  const sender = await browser.newContext();
  const scanner = await browser.newContext();
  const receiver = await browser.newContext();
  const replay = await browser.newContext();
  try {
    const link = await requestLink(sender, baseURL!, account.email);
    const preview = await scanner.newPage();
    let verificationCount = 0;
    preview.on('request', (request) => {
      if (request.url().includes('/api/auth/otp-verify')) verificationCount++;
    });
    await preview.goto(link);
    await expect(preview.getByRole('button', { name: 'ログインする', exact: true })).toBeVisible();
    await expect(preview).toHaveURL(/\/login\/link\?next=[^#]+$/);
    expect(verificationCount).toBe(0);

    const page = await receiver.newPage();
    await page.goto(link);
    await expect(page.getByText(`${account.email} でログインします。`)).toBeVisible();
    await page.getByRole('button', { name: 'ログインする', exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/dashboard?tab=all`);

    const reused = await replay.newPage();
    await reused.goto(link);
    await reused.getByRole('button', { name: 'ログインする', exact: true }).click();
    await expect(reused.getByLabel('メールアドレス', { exact: true })).toHaveValue(account.email);
    await expect(reused.getByLabel('メールアドレス', { exact: true })).toBeEditable();
    await expect(reused.getByRole('button', { name: 'ログインリンクを送信' })).toBeEnabled();
  } finally {
    await Promise.all([sender.close(), scanner.close(), receiver.close(), replay.close()]);
  }
});

test('ログイン中の端末で別アカウントへ切り替えることを押下前に表示する', async ({
  browser,
  baseURL,
}) => {
  const current = await createPlanner('切替前プランナー');
  const target = await createPlanner('切替先プランナー');
  const sender = await browser.newContext();
  const receiver = await browser.newContext();
  try {
    const page = await receiver.newPage();
    await loginAsPlanner(page, current);
    const link = await requestLink(sender, baseURL!, target.email);
    await page.goto(link);
    await expect(page.getByRole('status')).toContainText(`${target.email} に切り替えます`);
    await page.getByRole('button', { name: 'ログインする', exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/dashboard?tab=all`);
    await expect(page.getByRole('banner')).toContainText('切替先プランナー');
  } finally {
    await Promise.all([sender.close(), receiver.close()]);
  }
});
