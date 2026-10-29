import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium, request } from '@playwright/test';
import { getPlatformProxy } from 'wrangler';

const origin = 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));
const contexts = [];
async function login(name) {
  const context = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  contexts.push(context);
  assert.equal(
    (await context.post('/api/auth/password-login', { data: users[name] })).status(),
    200,
    name,
  );
  return context;
}
const body = (title, submissionFormat = 'text', extra = {}) => ({
  title,
  submissionFormat,
  description: 'D1ローカルの宿題',
  dueDate: '2027-05-20',
  importance: 'normal',
  isRequired: true,
  allowedFileTypes: [],
  options: {},
  ...extra,
});
async function add(staff, submissionFormat = 'text', extra = {}) {
  const result = await staff.post(`/api/cases/${ids.caseA}/tasks`, {
    data: body(`宿題検証 ${randomUUID()}`, submissionFormat, extra),
  });
  assert.equal(result.status(), 201, await result.text());
  return (await result.json()).id;
}
test(
  '宿題: 既存画面で提出→差し戻し→再提出→確認、4ロール・他式場・添付を検証',
  { timeout: 240000 },
  async () => {
    const platform = await getPlatformProxy({
      configPath: 'cloudflare/wrangler.jsonc',
      persist: { path: '.wrangler/app-local/v3' },
    });
    await platform.env.DB.prepare('DELETE FROM rateLimit').run();
    await platform.dispose();
    const browser = await chromium.launch({ headless: true }),
      external = [],
      errors = [];
    try {
      const planner = await login('plannerA'),
        couple = await login('coupleA'),
        foreign = await login('plannerB'),
        otherCouple = await login('coupleB');
      const admin = await login('adminA'),
        system = await login('system'),
        sameVenue = await login('plannerA2');
      const taskId = await add(planner),
        submit = `/api/tasks/${taskId}/submit`;
      const answer = { submissionType: 'text', textValue: '初回回答' };
      const anonymous = await request.newContext({
        baseURL: origin,
        extraHTTPHeaders: { Origin: origin },
      });
      contexts.push(anonymous);
      assert.equal((await anonymous.post(submit, { data: answer })).status(), 401);
      assert.equal((await planner.post(submit, { data: answer })).status(), 403);
      assert.equal((await otherCouple.post(submit, { data: answer })).status(), 404);
      assert.equal(
        (
          await couple.post(submit, { data: answer, headers: { Origin: 'https://evil.example' } })
        ).status(),
        403,
      );
      assert.equal(
        (await couple.post(submit, { data: { submissionType: 'text', textValue: '' } })).status(),
        400,
      );
      assert.equal(
        (
          await couple.post(submit, { data: { submissionType: 'select', selectedValue: '偽' } })
        ).status(),
        409,
      );
      const coupleContext = await browser.newContext({ storageState: await couple.storageState() });
      const staffContext = await browser.newContext({ storageState: await planner.storageState() });
      for (const context of [coupleContext, staffContext]) {
        context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
        await context.route('**/*', async (r) => {
          const url = new URL(r.request().url());
          if (url.protocol.startsWith('http') && url.origin !== origin) {
            external.push(url.origin);
            await r.abort();
          } else await r.continue();
        });
      }
      const page = await coupleContext.newPage(),
        staffPage = await staffContext.newPage();
      await page.goto(`${origin}/mypage/tasks/${taskId}`);
      await page.getByLabel('回答', { exact: true }).fill('最初の提出内容');
      await page.getByRole('button', { name: '一時保存', exact: true }).click();
      await page.getByText('入力中の内容を保存しました。あとから続きを入力できます。').waitFor();
      await page.reload();
      assert.equal(await page.getByLabel('回答', { exact: true }).inputValue(), '最初の提出内容');
      await page.getByRole('button', { name: '提出する', exact: true }).click();
      await page.waitForURL('**/mypage/tasks');
      const getLatest = async () => {
        const p = await getPlatformProxy({
          configPath: 'cloudflare/wrangler.jsonc',
          persist: { path: '.wrangler/app-local/v3' },
        });
        try {
          return await p.env.DB.prepare(
            'SELECT id FROM task_submissions WHERE case_task_id=? AND is_latest=1',
          )
            .bind(taskId)
            .first();
        } finally {
          await p.dispose();
        }
      };
      const first = (await getLatest()).id,
        review = `/api/submissions/${first}/review`;
      for (const context of [foreign, sameVenue]) {
        assert.equal(
          (await context.post(review, { data: { decision: 'confirmed' } })).status(),
          404,
        );
        assert.equal((await context.get(`/submissions/${first}`)).status(), 404);
      }
      assert.equal((await couple.post(review, { data: { decision: 'confirmed' } })).status(), 403);
      assert.equal((await admin.get(`/submissions/${first}`)).status(), 200);
      assert.equal((await system.get(`/submissions/${first}`)).status(), 200);
      assert.equal((await otherCouple.get(`/mypage/tasks/${taskId}`)).status(), 404);
      assert.equal(
        (await couple.post(review, { data: { decision: 'needs_fix', comment: '偽装' } })).status(),
        403,
      );
      assert.equal((await planner.post(review, { data: { decision: 'needs_fix' } })).status(), 400);
      await staffPage.goto(`${origin}/submissions`);
      await staffPage.locator(`a[href="/submissions/${first}"]`).click();
      await staffPage.getByText('最初の提出内容', { exact: true }).waitFor();
      await staffPage.getByRole('radio', { name: '不備あり', exact: true }).check();
      await staffPage.getByLabel('コメント', { exact: false }).fill('人数を追記してください');
      await staffPage.getByRole('button', { name: '確定する', exact: true }).click();
      await staffPage.waitForURL(`**/cases/${ids.caseA}`);
      await page.goto(`${origin}/mypage/tasks/${taskId}`);
      await page.getByText('人数を追記してください', { exact: true }).waitFor();
      await page.getByLabel('回答', { exact: true }).fill('人数を追記した回答');
      await page.getByRole('button', { name: '提出する', exact: true }).click();
      await page.waitForURL('**/mypage/tasks');
      const second = (await getLatest()).id;
      assert.notEqual(first, second);
      assert.equal((await planner.post(review, { data: { decision: 'confirmed' } })).status(), 409);
      await staffPage.goto(`${origin}/submissions/${second}`);
      await staffPage.getByRole('radio', { name: '確認済', exact: true }).check();
      await staffPage.getByRole('button', { name: '確定する', exact: true }).click();
      await staffPage.waitForURL(`**/cases/${ids.caseA}`);
      await page.goto(`${origin}/mypage/tasks/${taskId}`);
      await page
        .getByText('確認済みです。内容を変えたいときは、入力し直して提出してください。')
        .waitFor();
      await mkdir('.wrangler/app-local/evidence', { recursive: true });
      await page.screenshot({
        path: '.wrangler/app-local/evidence/tasks-confirmed.png',
        fullPage: true,
      });
      // select / none とファイルも同じ本体APIで送信する。
      const select = await add(planner, 'select', { options: { choices: ['参加', '欠席'] } });
      assert.equal(
        (
          await couple.post(`/api/tasks/${select}/submit`, {
            data: { submissionType: 'select', selectedValue: '範囲外' },
          })
        ).status(),
        400,
      );
      assert.equal(
        (
          await couple.post(`/api/tasks/${select}/submit`, {
            data: { submissionType: 'select', selectedValue: '参加' },
          })
        ).status(),
        200,
      );
      const none = await add(planner, 'none');
      assert.equal(
        (
          await couple.post(`/api/tasks/${none}/submit`, {
            data: { submissionType: 'none', draft: true },
          })
        ).status(),
        400,
      );
      assert.equal(
        (
          await couple.post(`/api/tasks/${none}/submit`, { data: { submissionType: 'none' } })
        ).status(),
        200,
      );
      const fileTask = await add(planner, 'file', { allowedFileTypes: ['csv'] });
      const upload = await couple.post('/api/files/upload', {
        multipart: {
          taskId: fileTask,
          file: {
            name: '出席者.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from('名前,人数\n検証,2\n'),
          },
        },
      });
      assert.equal(upload.status(), 201, await upload.text());
      const fileId = (await upload.json()).fileId;
      assert.equal((await foreign.get(`/api/files/${fileId}/download`)).status(), 404);
      assert.equal(
        (await planner.get(`/api/files/${fileId}/download`)).status(),
        404,
        '提出前のファイルを隠す',
      );
      assert.equal(
        (
          await otherCouple.post(`/api/tasks/${fileTask}/submit`, {
            data: { submissionType: 'file', fileId },
          })
        ).status(),
        404,
      );
      const fileSubmit = await couple.post(`/api/tasks/${fileTask}/submit`, {
        data: { submissionType: 'file', fileId },
      });
      assert.equal(fileSubmit.status(), 200);
      const download = await planner.get(`/api/files/${fileId}/download`);
      assert.equal(download.status(), 200);
      const raw = await planner.get((await download.json()).url);
      assert.equal(raw.status(), 200);
      assert.match(await raw.text(), /検証,2/);
      assert.match(raw.headers()['cache-control'], /no-store/);
      assert.equal((await foreign.get(`/api/files/${fileId}/download?raw=1`)).status(), 404);
      assert.equal(
        (
          await planner.post(`/api/submissions/${(await fileSubmit.json()).id}/review`, {
            data: { decision: 'confirmed' },
          })
        ).status(),
        200,
      );
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      await writeFile(
        '.wrangler/app-local/evidence/tasks-result.json',
        JSON.stringify(
          {
            submitted: true,
            returned: true,
            resubmitted: true,
            confirmed: true,
            fourRoles: true,
            otherVenueDenied: true,
            formats: ['text', 'select', 'none', 'file'],
            externalRequests: external,
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
      await Promise.all(contexts.map((c) => c.dispose()));
    }
  },
);
