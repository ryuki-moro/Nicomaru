import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, request } from '@playwright/test';

const origin = 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));

test(
  'Issue #189: 一時保存後の添付名、失敗後の再試行、同じファイルの再選択',
  { timeout: 120_000 },
  async () => {
    const contexts = [];
    let releaseActiveRsc = () => {};
    const login = async (name) => {
      const context = await request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { Origin: origin },
        timeout: 120_000,
      });
      contexts.push(context);
      const response = await context.post('/api/auth/password-login', { data: users[name] });
      assert.equal(response.status(), 200, `login ${name}`);
      return context;
    };

    const planner = await login('plannerA');
    const couple = await login('coupleA');
    const taskResponse = await planner.post(`/api/cases/${ids.caseA}/tasks`, {
      data: {
        title: 'Issue 189 添付名確認',
        submissionFormat: 'file',
        description: 'ブラウザ回帰試験',
        dueDate: '2027-05-20',
        importance: 'normal',
        isRequired: true,
        allowedFileTypes: ['csv'],
        options: {},
      },
    });
    assert.equal(taskResponse.status(), 201, await taskResponse.text());
    const taskId = (await taskResponse.json()).id;
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });

    try {
      const browserContext = await browser.newContext({
        storageState: await couple.storageState(),
      });
      const page = await browserContext.newPage();
      page.setDefaultTimeout(120_000);
      await mkdir('docs/ui-review/issue-189', { recursive: true });
      await page.goto(`${origin}/mypage/tasks/${taskId}`);

      let holdRsc = false;
      let releaseRsc = () => {};
      let rscRequestSeen = () => {};
      let rscGate = Promise.resolve();
      let rscSeen = Promise.resolve();
      let failNextSubmit = false;
      let failNextUpload = false;
      let uploadCount = 0;
      const holdNextRefresh = () => {
        holdRsc = true;
        rscGate = new Promise((resolve) => {
          releaseRsc = resolve;
          releaseActiveRsc = resolve;
        });
        rscSeen = new Promise((resolve) => {
          rscRequestSeen = resolve;
        });
      };
      const releaseRefresh = () => {
        holdRsc = false;
        releaseRsc();
      };

      page.on('request', (browserRequest) => {
        if (new URL(browserRequest.url()).pathname === '/api/files/upload') uploadCount += 1;
      });
      await page.route('**/*', async (route) => {
        const browserRequest = route.request();
        const url = new URL(browserRequest.url());
        if (url.pathname === '/api/files/upload' && failNextUpload) {
          failNextUpload = false;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'INTERNAL_ERROR', message: 'ファイルを送信できませんでした。' },
            }),
          });
          return;
        }
        if (url.pathname === `/api/tasks/${taskId}/submit` && failNextSubmit) {
          failNextSubmit = false;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'INTERNAL_ERROR', message: '一時保存に失敗しました。' },
            }),
          });
          return;
        }
        if (holdRsc && (browserRequest.headers().rsc === '1' || url.searchParams.has('_rsc'))) {
          rscRequestSeen();
          await rscGate;
        }
        await route.continue();
      });

      const chooseFile = async (name) =>
        page.locator('#answer-file').setInputFiles({
          name,
          mimeType: 'text/csv',
          buffer: Buffer.from('name,count\ncheck,1\n'),
        });
      const saveDraft = () => page.getByRole('button', { name: '一時保存', exact: true }).click();
      const savedNotice = '入力中の内容を保存しました。あとから続きを入力できます。';

      await chooseFile('initial.csv');
      holdNextRefresh();
      await saveDraft();
      await page.getByText(savedNotice, { exact: true }).waitFor();
      await rscSeen;
      assert.match(await page.locator('[aria-live="polite"]').innerText(), /initial\.csv/);
      await page.screenshot({
        path: 'docs/ui-review/issue-189/initial-save-before-refresh.png',
        fullPage: true,
      });
      releaseRefresh();
      await page.getByText('現在の添付: initial.csv', { exact: false }).waitFor();
      await page.screenshot({ path: 'docs/ui-review/issue-189/initial-saved.png', fullPage: true });
      await chooseFile('initial.csv');
      assert.match(await page.locator('[aria-live="polite"]').innerText(), /initial\.csv/);

      await chooseFile('replacement.csv');
      failNextSubmit = true;
      await saveDraft();
      await page.getByText('一時保存に失敗しました。', { exact: true }).waitFor();
      assert.match(await page.locator('[aria-live="polite"]').innerText(), /replacement\.csv/);
      assert.equal(await page.getByText(savedNotice, { exact: true }).count(), 0);
      assert.equal(uploadCount, 2, '差し替えファイルは一度だけアップロードする');
      await page.screenshot({
        path: 'docs/ui-review/issue-189/submit-failed-pending-file.png',
        fullPage: true,
      });
      await page.locator('#answer-file').setInputFiles([]);
      assert.match(await page.locator('[aria-live="polite"]').innerText(), /replacement\.csv/);

      holdNextRefresh();
      await saveDraft();
      await page.getByText(savedNotice, { exact: true }).waitFor();
      await rscSeen;
      assert.match(await page.locator('[aria-live="polite"]').innerText(), /replacement\.csv/);
      assert.equal(uploadCount, 2, '保存の再試行で差し替えファイルを再送しない');
      await page.screenshot({
        path: 'docs/ui-review/issue-189/replacement-save-before-refresh.png',
        fullPage: true,
      });
      releaseRefresh();
      await page.getByText('現在の添付: replacement.csv', { exact: false }).waitFor();
      await page.reload();
      await page.getByText('現在の添付: replacement.csv', { exact: false }).waitFor();
      await page.screenshot({
        path: 'docs/ui-review/issue-189/replacement-reloaded.png',
        fullPage: true,
      });

      await chooseFile('retry.csv');
      failNextUpload = true;
      await saveDraft();
      await page
        .getByRole('alert')
        .filter({ hasText: 'ファイルを送信できませんでした。' })
        .waitFor();
      assert.equal(await page.getByText(savedNotice, { exact: true }).count(), 0);
      assert.match(await page.locator('[aria-live="polite"]').innerText(), /retry\.csv/);
      await saveDraft();
      await page.getByText(savedNotice, { exact: true }).waitFor();
      await page.getByText('現在の添付: retry.csv', { exact: false }).waitFor();
      assert.equal(uploadCount, 4, 'アップロード失敗後の再試行で再送する');
      await page.screenshot({
        path: 'docs/ui-review/issue-189/upload-retry-saved.png',
        fullPage: true,
      });

      await browserContext.close();
    } finally {
      releaseActiveRsc();
      await browser.close();
      await Promise.all(contexts.map((context) => context.dispose()));
    }
  },
);
