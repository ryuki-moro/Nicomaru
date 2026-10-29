import { test, beforeEach } from 'node:test';
import { getPlatformProxy } from 'wrangler';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, request } from '@playwright/test';

const origin = 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));
beforeEach(async () => {
  const platform = await getPlatformProxy({
    configPath: 'cloudflare/wrangler.jsonc',
    persist: { path: '.wrangler/app-local/v3' },
  });
  try {
    await platform.env.DB.prepare('DELETE FROM rateLimit').run();
  } finally {
    await platform.dispose();
  }
});
const fixtureCases = (rows) =>
  rows.filter((row) => [ids.caseA, ids.caseA2, ids.caseB].includes(row.id));
const contexts = [];
async function login(name) {
  const context = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  contexts.push(context);
  const response = await context.post('/api/auth/password-login', { data: users[name] });
  assert.equal(response.status(), 200, `login ${name}`);
  return context;
}
test('本体API: 4ロール・他式場・権限昇格・CSRF・失効', { timeout: 180000 }, async () => {
  try {
    const anonymous = await request.newContext({ baseURL: origin });
    contexts.push(anonymous);
    assert.equal((await anonymous.get('/api/cases')).status(), 401);
    const system = await login('system');
    assert.equal(fixtureCases((await (await system.get('/api/cases')).json()).cases).length, 3);
    for (const name of ['adminA', 'plannerA', 'adminB']) {
      const context = await login(name);
      const own = name === 'adminB' ? ids.caseB : ids.caseA;
      const foreign = name === 'adminB' ? ids.caseA : ids.caseB;
      const count = name === 'adminA' ? 2 : 1;
      assert.equal(
        fixtureCases((await (await context.get('/api/cases')).json()).cases).length,
        count,
      );
      assert.equal((await context.get(`/api/cases/${own}`)).status(), 200);
      const denied = await context.get(`/api/cases/${foreign}`);
      const missing = await context.get('/api/cases/not-present');
      assert.equal(denied.status(), 404);
      assert.deepEqual(await denied.json(), await missing.json());
      assert.equal(
        (await context.patch(`/api/cases/${foreign}`, { data: { guestCount: 999 } })).status(),
        404,
      );
      const spoofed = await context.get('/api/cases?venueId=' + ids.venueB, {
        headers: { 'x-user-role': 'system_admin', 'x-venue-id': ids.venueB },
      });
      assert.equal(fixtureCases((await spoofed.json()).cases).length, count);
      assert.equal(
        (
          await context.patch(`/api/cases/${own}`, {
            data: { venueId: ids.venueB, role: 'system_admin' },
          })
        ).status(),
        400,
      );
      assert.equal(
        (
          await context.patch(`/api/cases/${own}`, {
            data: { guestCount: 61 },
            headers: { Origin: 'https://evil.example' },
          })
        ).status(),
        403,
      );
      assert.equal(
        (await context.patch(`/api/cases/${own}`, { data: { weddingTime: '24:99' } })).status(),
        400,
      );
      if (name === 'plannerA') {
        assert.equal((await context.get(`/api/cases/${ids.caseA2}`)).status(), 404);
        assert.equal(
          (
            await context.patch(`/api/cases/${own}`, { data: { primaryPlannerId: ids.plannerA2 } })
          ).status(),
          403,
        );
        assert.equal(
          (await context.patch(`/api/cases/${own}`, { data: { archived: true } })).status(),
          403,
        );
      }
    }
    const couple = await login('coupleA');
    const safe = await (await couple.get('/api/mypage/case')).json();
    assert.equal(safe.id, ids.caseA);
    for (const field of ['notes', 'risk', 'primaryPlanner', 'email'])
      assert.equal(Object.hasOwn(safe, field), false);
    assert.equal(JSON.stringify(safe).includes('内部メモ'), false);
    assert.equal((await couple.get('/api/mypage/case?caseId=' + ids.caseB)).status(), 404);
    assert.equal((await couple.get('/api/cases')).status(), 403);
    assert.equal((await couple.get(`/api/cases/${ids.caseA}`)).status(), 403);
    assert.equal(
      (await couple.patch(`/api/cases/${ids.caseA}`, { data: { guestCount: 999 } })).status(),
      403,
    );
    for (const name of ['suspended', 'invited', 'deleted']) {
      const response = await anonymous.post('/api/auth/password-login', {
        data: users[name],
        headers: { Origin: origin },
      });
      assert.equal(response.status(), 401, name);
    }
    const bad = await anonymous.post('/api/auth/password-login', {
      data: { email: users.adminA.email, password: crypto.randomUUID() },
      headers: { Origin: origin },
    });
    assert.equal(bad.status(), 401);
    const before = await system.storageState();
    assert.ok(before.cookies.some((c) => c.httpOnly && c.sameSite === 'Lax'));
    await system.post('/api/auth/sign-out', { data: {} });
    assert.equal((await system.get('/api/cases')).status(), 401);
    const replay = await request.newContext({ baseURL: origin, storageState: before });
    contexts.push(replay);
    assert.equal((await replay.get('/api/cases')).status(), 401);
    assert.equal((await anonymous.post('/api/auth/sign-up/email', { data: {} })).status(), 503);
    assert.equal((await anonymous.get('/api/venues')).status(), 503);
    const response = await (await login('adminB')).get(`/api/cases/${ids.caseB}`);
    assert.equal((await response.json()).guestCount, 50);
    assert.match(response.headers()['cache-control'], /no-store/);
  } finally {
    await Promise.all(contexts.map((c) => c.dispose()));
  }
});

test(
  '既存画面: 全ロールでログイン、編集・確認・再読込・ログアウト',
  { timeout: 180000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 980 } });
    const errors = [],
      external = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol.startsWith('http') && url.origin !== origin) {
        external.push(url.origin);
        await route.abort();
      } else await route.continue();
    });
    await mkdir('.wrangler/app-local/evidence', { recursive: true });
    try {
      for (const name of ['adminA', 'plannerA', 'system', 'coupleA']) {
        await page.goto(origin + '/login?mode=password');
        await page.getByLabel('メールアドレス', { exact: true }).fill(users[name].email);
        await page.getByLabel('パスワード', { exact: true }).fill(users[name].password);
        await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
        await page.waitForURL(name === 'coupleA' ? '**/mypage' : '**/cases');
        if (name === 'coupleA') {
          await page.getByRole('heading', { name: '次にやること' }).waitFor();
          assert.equal((await page.locator('body').innerText()).includes('内部メモ'), false);
          await page.goto(origin + `/cases/${ids.caseA}/edit`);
          await page.waitForURL('**/mypage');
        } else {
          await page.getByRole('heading', { name: '案件一覧', exact: true }).waitFor();
          if (name !== 'system')
            assert.equal((await page.locator('main').innerText()).includes('B-001'), false);
          if (name === 'plannerA') {
            await page.goto(origin + `/cases/${ids.caseA}/edit`);
            await page.getByLabel('人数（任意）').fill('72');
            const dateInput = page.getByLabel('挙式日（必須）');
            const date =
              (await dateInput.inputValue()) === '2027-06-25' ? '2027-06-26' : '2027-06-25';
            await dateInput.fill(date);
            await page.getByRole('button', { name: '更新する', exact: true }).click();
            const dialog = page.getByRole('button', { name: 'この内容で更新する', exact: true });
            await dialog.waitFor();
            await dialog.click();
            await page.waitForURL(`**/cases/${ids.caseA}`);
            await page.reload();
            await page.getByText('72名', { exact: true }).waitFor();
            await page.screenshot({
              path: '.wrangler/app-local/evidence/case-after-update.png',
              fullPage: true,
            });
          }
        }
        await page.screenshot({ path: `.wrangler/app-local/evidence/${name}.png`, fullPage: true });
        await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
        await page.waitForURL('**/login');
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await writeFile(
        '.wrangler/app-local/evidence/result.json',
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            roles: 4,
            updateAndReload: true,
            coupleStaffPageDenied: true,
            pageErrors: errors,
            externalRequests: external,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
    }
  },
);
