import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect, request } from '@playwright/test';

const origin = process.env.UI_TEST_ORIGIN ?? 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));

test(
  'Issue #188: ダイアログの初期focus、Tab、Escape、保存中、成功・失敗',
  { timeout: 180_000 },
  async () => {
    const auth = await request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Origin: origin },
      timeout: 120_000,
    });
    const login = await auth.post('/api/auth/password-login', { data: users.adminA });
    assert.equal(login.status(), 200, 'admin login');
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({ storageState: await auth.storageState() });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(120_000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await mkdir('docs/ui-review/issue-188', { recursive: true });

    const openPreview = async () => {
      await page.goto(`${origin}/cases/${ids.caseA}/edit`);
      const date = page.locator('#weddingDate');
      const currentDate = await date.inputValue();
      const nextDate = new Date(`${currentDate}T00:00:00Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 14);
      await date.fill(nextDate.toISOString().slice(0, 10));
      await page.getByRole('button', { name: '更新する' }).click();
      const dialog = page.getByRole('dialog', { name: '変更内容の確認' });
      await dialog.waitFor({ state: 'visible' });
      return dialog;
    };

    try {
      let dialog = await openPreview();
      const cancel = dialog.getByRole('button', { name: 'やめる' });
      await cancel.waitFor();
      await expect(cancel).toBeFocused();
      await page.screenshot({ path: 'docs/ui-review/issue-188/dialog.png', fullPage: true });

      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'この内容で更新する' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused();

      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await expect(page.getByRole('button', { name: '更新する' })).toBeFocused();

      dialog = await openPreview();
      await dialog.getByRole('button', { name: 'やめる' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await expect(page.getByRole('button', { name: '更新する' })).toBeFocused();

      dialog = await openPreview();
      let confirmSeen = () => {};
      const confirmRequest = new Promise((resolve) => {
        confirmSeen = resolve;
      });
      let releaseConfirm = () => {};
      const confirmGate = new Promise((resolve) => {
        releaseConfirm = resolve;
      });
      await page.route(`**/api/cases/${ids.caseA}`, async (route) => {
        const payload = route.request().postDataJSON();
        if (route.request().method() === 'PATCH' && payload.confirmed === true) {
          confirmSeen();
          await confirmGate;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ applied: true }),
          });
        } else {
          await route.continue();
        }
      });
      try {
        await dialog.getByRole('button', { name: 'この内容で更新する' }).click();
        await confirmRequest;
        assert.equal(await dialog.getByRole('button', { name: 'やめる' }).isDisabled(), true);
        await page.keyboard.press('Escape');
        assert.equal(await dialog.isVisible(), true, 'busy dialog cannot be cancelled');
        releaseConfirm();
        await page.waitForURL(`${origin}/cases/${ids.caseA}`);
        await dialog.waitFor({ state: 'hidden' });
      } finally {
        releaseConfirm();
      }

      await page.unrouteAll({ behavior: 'wait' });
      dialog = await openPreview();
      await page.route(`**/api/cases/${ids.caseA}`, async (route) => {
        const payload = route.request().postDataJSON();
        if (route.request().method() === 'PATCH' && payload.confirmed === true) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'INTERNAL_ERROR', message: '検証用の保存失敗', details: [] },
            }),
          });
        } else {
          await route.continue();
        }
      });
      await dialog.getByRole('button', { name: 'この内容で更新する' }).click();
      await page.getByRole('alert').filter({ hasText: '検証用の保存失敗' }).waitFor();
      await dialog.waitFor({ state: 'hidden' });
      await expect(page.getByRole('button', { name: '更新する' })).toBeFocused();
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
      await browser.close();
      await auth.dispose();
    }
  },
);
