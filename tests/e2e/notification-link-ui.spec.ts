/** 通知の宿題URLからの復帰。認証APIと宿題HTMLを差し替え、実送信・DB操作はしない。 */
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const method of ['code', 'email-link'] as const) {
  test(`通知の宿題URLから${method}で認証し、同じ宿題へ戻る`, async ({ page, browser }) => {
    const taskPath = '/mypage/tasks/22222222-2222-4222-8222-222222222222';
    const email = 'notification@example.test';
    let verified = 0;
    let requestedNext: string | undefined;
    const intercept = async (target: Page) => {
      await target.route('**/auth/v1/**', (route) => route.abort());
      await target.route('**/api/auth/**', (route) => route.abort());
      await target.route('**/api/auth/otp-request', async (route) => {
        requestedNext = route.request().postDataJSON().next;
        await route.fulfill({ status: 204 });
      });
      await target.route('**/api/auth/otp-verify', async (route) => {
        expect(route.request().postDataJSON()).toEqual({ email, code: '123456' });
        verified++;
        await route.fulfill({ json: { redirectTo: '/mypage' } });
      });
      await target.route(`**${taskPath}**`, (route) =>
        verified
          ? route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: '<h1>通知の対象宿題</h1>',
            })
          : route.continue(),
      );
    };
    await intercept(page);
    await page.goto(taskPath);
    await page.waitForURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get('next')).toBe(taskPath);
    await page.getByLabel('メールアドレス', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'ログインリンクを送信', exact: true }).click();
    await expect(page.getByRole('group', { name: 'ワンタイムコード' })).toBeVisible();
    expect(requestedNext).toBe(taskPath);

    const receiver = method === 'email-link' ? await browser.newContext() : null;
    const target = receiver ? await receiver.newPage() : page;
    try {
      if (receiver) {
        await intercept(target);
        await target.goto(
          `/login/link?next=${encodeURIComponent(requestedNext!)}#e=${encodeURIComponent(email)}&c=123456`,
        );
        await expect(
          target.getByRole('button', { name: 'ログインする', exact: true }),
        ).toBeVisible();
        expect(verified).toBe(0);
        await target.getByRole('button', { name: 'ログインする', exact: true }).click();
      } else {
        await page.getByLabel('ワンタイムコード 1桁目', { exact: true }).click();
        await page.keyboard.type('123456');
      }
      await target.waitForURL((url) => url.pathname === taskPath && url.search === '');
      await expect(target.getByRole('heading', { name: '通知の対象宿題' })).toBeVisible();
      expect(verified).toBe(1);
    } finally {
      await receiver?.close();
    }
  });
}
