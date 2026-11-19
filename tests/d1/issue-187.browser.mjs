import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { request, chromium } from '@playwright/test';

const origin = 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));

test('新規・編集フォームで先頭エラーへ移動し、修正後の送信を続けられる', async () => {
  const auth = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    timeout: 120_000,
  });
  assert.equal((await auth.post('/api/auth/password-login', { data: users.adminA })).status(), 200);
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const context = await browser.newContext({ storageState: await auth.storageState() });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mkdir('docs/ui-review/issue-187', { recursive: true });
  try {
    let creates = 0;
    await page.route('**/api/cases', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      creates += 1;
      if (creates === 1) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: '入力を確認してください',
              details: [
                { field: 'groomName', reason: '新郎氏名を確認してください' },
                { field: 'weddingDate', reason: '挙式日を確認してください' },
              ],
            },
          }),
        });
      }
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ caseId: 'mock-case', caseCode: 'MOCK', invitations: [] }),
      });
    });
    await page.route('**/api/cases/mock-case/assign-tasks', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"added":0}' }),
    );
    await page.goto(`${origin}/cases/new`);
    await page.locator('#weddingDate').fill('2027-12-01');
    await page.locator('#groomName').fill('保持する新郎名');
    await page.locator('#brideName').fill('テスト新婦');
    await page.locator('#contactEmail').fill('test@example.com');
    await page.getByRole('button', { name: '登録する' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'weddingDate');
    assert.equal(await page.locator('#groomName').inputValue(), '保持する新郎名');
    assert.equal(await page.locator('#weddingDate').getAttribute('aria-invalid'), 'true');
    assert.equal(
      await page.locator('#weddingDate').getAttribute('aria-describedby'),
      'weddingDate-error',
    );
    assert.equal(
      await page.locator('#guestCount').getAttribute('aria-describedby'),
      'guest-count-help',
    );
    const createRect = await page.locator('#weddingDate').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
    });
    assert.ok(
      createRect.top >= 0 && createRect.bottom <= createRect.height,
      '新規のエラー欄を画面内に表示',
    );
    await page.screenshot({ path: 'docs/ui-review/issue-187/create-error.png', fullPage: true });
    await page.locator('#weddingDate').fill('2027-12-02');
    await page.getByRole('button', { name: '登録する' }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(creates, 2, '修正後に再送信');

    await page.goto(`${origin}/cases/new`);
    await page.route('**/api/cases', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'INTERNAL_ERROR', message: '一時的なエラー', details: [] },
            }),
          })
        : route.continue(),
    );
    const createSubmit = page.getByRole('button', { name: '登録する' });
    await createSubmit.click();
    await page.getByRole('alert').filter({ hasText: '一時的なエラー' }).waitFor();
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'weddingDate');
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'groomName');

    let patches = 0;
    await page.route(`**/api/cases/${ids.caseA}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patches += 1;
      if (patches === 1) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: '変更内容を確認してください',
              details: [
                { field: 'groomName', reason: '新郎氏名を確認してください' },
                { field: 'weddingDate', reason: '挙式日を確認してください' },
              ],
            },
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"applied":true}',
      });
    });
    await page.goto(`${origin}/cases/${ids.caseA}/edit`);
    await page.locator('#weddingDate').fill('2027-10-10');
    await page.locator('#groomName').fill('編集値を保持');
    await page.getByRole('button', { name: '更新する' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'weddingDate');
    assert.equal(await page.locator('#groomName').inputValue(), '編集値を保持');
    assert.equal(await page.locator('#weddingDate').getAttribute('aria-invalid'), 'true');
    assert.equal(
      await page.locator('#weddingDate').getAttribute('aria-describedby'),
      'weddingDate-error',
    );
    const editRect = await page.locator('#weddingDate').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
    });
    assert.ok(
      editRect.top >= 0 && editRect.bottom <= editRect.height,
      '編集のエラー欄を画面内に表示',
    );
    await page.screenshot({ path: 'docs/ui-review/issue-187/edit-error.png', fullPage: true });
    await page.locator('#weddingDate').fill('2027-10-11');
    await page.getByRole('button', { name: '更新する' }).click();
    await page.waitForURL(new RegExp(`/cases/${ids.caseA}$`));
    assert.equal(patches, 2, '編集値を修正して再送信');

    await page.goto(`${origin}/cases/${ids.caseA}/edit`);
    await page.locator('#groomName').fill('通信エラー確認');
    await page.route(`**/api/cases/${ids.caseA}`, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'INTERNAL_ERROR', message: '一時的なエラー', details: [] },
            }),
          })
        : route.continue(),
    );
    await page.getByRole('button', { name: '更新する' }).click();
    await page.getByRole('alert').filter({ hasText: '一時的なエラー' }).waitFor();
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'weddingDate');
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'groomName');
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await auth.dispose();
  }
});
