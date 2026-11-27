import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, request } from '@playwright/test';

const origin = 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));

async function login(name) {
  const context = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    timeout: 120_000,
  });
  const response = await context.post('/api/auth/password-login', { data: users[name] });
  assert.equal(response.status(), 200, `login ${name}`);
  return context;
}

async function createTask(planner, title) {
  const response = await planner.post(`/api/cases/${ids.caseA}/tasks`, {
    data: {
      title,
      submissionFormat: 'text',
      dueDate: '2027-05-20',
      importance: 'normal',
      isRequired: true,
      allowedFileTypes: [],
      options: {},
    },
  });
  assert.equal(response.status(), 201, await response.text());
  return (await response.json()).id;
}

test(
  'チャット連携: やることを添付→新郎新婦のカードから移動、提出でシステムメッセージが届く',
  { timeout: 240_000 },
  async () => {
    const contexts = [];
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const errors = [];
    try {
      const plannerApi = await login('plannerA');
      const coupleApi = await login('coupleA');
      contexts.push(plannerApi, coupleApi);
      const tag = randomUUID().slice(0, 8);
      const title = `チャット添付 ${tag}`;
      const taskId = await createTask(plannerApi, title);

      const open = async (api) => {
        const context = await browser.newContext({ storageState: await api.storageState() });
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        page.on('pageerror', (e) => errors.push(e.message));
        return page;
      };
      const planner = await open(plannerApi);
      const couple = await open(coupleApi);

      // スタッフが添付ダイアログで選び、チップを確かめてから送る
      await planner.goto(`${origin}/cases/${ids.caseA}/chat`);
      await planner.getByRole('button', { name: '添付', exact: true }).click();
      const dialog = planner.getByRole('dialog', { name: '添付する項目を選ぶ' });
      await dialog.getByLabel('さがす').fill(tag);
      await dialog.getByRole('button', { name: title }).click();
      await dialog.getByRole('button', { name: '閉じる' }).click();
      await planner.getByRole('list', { name: '添付する項目' }).getByText(title).waitFor();
      const posted = planner.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/messages'),
      );
      await planner.getByRole('button', { name: '送信', exact: true }).click();
      assert.equal((await posted).status(), 201);

      // 新郎新婦にはカードで見え、押すとマイページのやることが開く
      await couple.goto(`${origin}/mypage/chat`);
      const card = couple
        .getByRole('list', { name: '添付された項目' })
        .getByRole('link', { name: new RegExp(title) });
      await card.click();
      await couple.waitForURL(`**/mypage/tasks/${taskId}`);

      // 新郎新婦が提出すると、スタッフのチャットにシステムメッセージが出る
      const submitted = await coupleApi.post(`/api/tasks/${taskId}/submit`, {
        data: { submissionType: 'text', textValue: '回答です', draft: false },
      });
      assert.equal(submitted.status(), 200, await submitted.text());
      await planner.reload();
      await planner
        .locator('[data-system-message]', { hasText: `『${title}』を提出しました` })
        .waitFor();

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await Promise.all(contexts.map((c) => c.dispose()));
    }
  },
);
