import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request, chromium } from '@playwright/test';
import { getPlatformProxy } from 'wrangler';

const origin = 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));
beforeEach(async () => {
  const platform = await getPlatformProxy({
    configPath: 'cloudflare/wrangler.jsonc',
    persist: { path: '.wrangler/app-local/v3' },
  });
  try {
    await platform.env.DB.batch([
      platform.env.DB.prepare('DELETE FROM rateLimit'),
      platform.env.DB.prepare('DELETE FROM app_auth_limits'),
    ]);
  } finally {
    await platform.dispose();
  }
});

test('D1で案件登録→招待→OTP本人確認→マイページの順に完了する', { timeout: 120000 }, async () => {
  const staff = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  const couple = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  try {
    assert.equal(
      (await staff.post('/api/auth/password-login', { data: users.plannerA })).status(),
      200,
    );
    const email = `couple-${randomUUID()}@example.test`;
    const createdResponse = await staff.post('/api/cases', {
      data: {
        weddingDate: '2028-06-20',
        groomName: '招待 太郎',
        brideName: '招待 花子',
        contactEmail: email,
        primaryContact: 'bride',
        contactChannel: 'email',
        planTypeId: ids.planA,
        guestCount: 60,
      },
    });
    assert.equal(createdResponse.status(), 201);
    const created = await createdResponse.json();
    assert.equal(created.invitations.length, 2);
    const invitation = created.invitations.find((i) => i.targetPartnerRole === 'bride');
    const token = new URL(invitation.url).pathname.split('/').at(-1);
    const registration = { token, email, fullName: '本人確認 花子', termsAccepted: true };
    const pending = await couple.post('/api/auth/initial-register', { data: registration });
    assert.equal(pending.status(), 200);
    assert.equal((await pending.json()).status, 'verification_required');
    assert.equal((await couple.get('/api/mypage/case')).status(), 401);
    assert.equal(
      (
        await couple.get('/api/dev/mailbox', { headers: { 'sec-fetch-site': 'cross-site' } })
      ).status(),
      403,
    );
    assert.equal(
      (
        await couple.get('/api/dev/mailbox', {
          headers: { Origin: 'http://127.0.0.1:9999', 'sec-fetch-site': 'same-site' },
        })
      ).status(),
      403,
    );
    assert.equal((await couple.post('/api/auth/otp-request', { data: { email } })).status(), 204);
    const mailbox = await (await staff.get('/api/dev/mailbox')).json();
    const mail = mailbox.messages.find((m) => m.kind === 'otp' && m.email === email);
    assert.match(mail.code, /^\d{6}$/);
    const verified = await couple.post('/api/auth/otp-verify', {
      data: { email, code: mail.code },
    });
    assert.equal(verified.status(), 200);
    assert.equal((await couple.get('/api/mypage/case')).status(), 404);
    const completed = await couple.post('/api/auth/initial-register', { data: registration });
    assert.equal(completed.status(), 200);
    assert.equal((await completed.json()).status, 'registered');
    assert.equal((await (await couple.get('/api/mypage/case')).json()).id, created.caseId);
    assert.equal((await couple.get(`/api/mypage/case?caseId=${ids.caseB}`)).status(), 404);
    assert.equal(
      (await couple.post('/api/auth/otp-verify', { data: { email, code: mail.code } })).status(),
      422,
    );
    assert.equal(
      (await couple.post('/api/auth/initial-register', { data: registration })).status(),
      422,
    );
    assert.equal((await couple.post('/api/cases', { data: {} })).status(), 403);
    assert.equal((await couple.post('/api/auth/otp-request', { data: { email } })).status(), 429);
    const unknown = `unknown-${randomUUID()}@example.test`;
    assert.equal(
      (await couple.post('/api/auth/otp-request', { data: { email: unknown } })).status(),
      204,
    );
    assert.equal(
      (
        await couple.post('/api/auth/otp-request', { data: { email: users.adminA.email } })
      ).status(),
      204,
    );
    const messages = (await (await staff.get('/api/dev/mailbox')).json()).messages;
    assert.equal(
      messages.some((m) => m.email === unknown || m.email === users.adminA.email),
      false,
    );
  } finally {
    await staff.dispose();
    await couple.dispose();
  }
});

test(
  '既存画面で案件作成・招待の模擬送信・初回OTP確認・ログアウト後のOTP再ログイン',
  { timeout: 180000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    const staffContext = await browser.newContext({ baseURL: origin }),
      coupleContext = await browser.newContext({ baseURL: origin });
    const staff = await staffContext.newPage(),
      couple = await coupleContext.newPage();
    const errors = [],
      external = [];
    for (const context of [staffContext, coupleContext]) {
      context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.protocol.startsWith('http') && url.origin !== origin) {
          external.push(url.origin);
          await route.abort();
        } else await route.continue();
      });
    }
    staff.on('pageerror', (error) => errors.push(error.message));
    couple.on('pageerror', (error) => errors.push(error.message));
    try {
      await staff.goto(origin + '/login?mode=password');
      await staff.getByLabel('メールアドレス', { exact: true }).fill(users.plannerA.email);
      await staff.getByLabel('パスワード', { exact: true }).fill(users.plannerA.password);
      await staff.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
      await staff.waitForURL('**/cases');
      await staff.getByRole('link', { name: '新規案件登録', exact: true }).click();
      await staff.locator('#weddingDate').fill('2028-09-20');
      await staff.locator('#groomName').fill('画面検証 太郎');
      await staff.locator('#brideName').fill('画面検証 花子');
      const email = `ui-${randomUUID()}@example.test`;
      await staff.locator('#contactEmail').fill(email);
      await staff.locator('#guestCount').fill('68');
      const createdResponse = staff.waitForResponse(
        (r) => r.url() === origin + '/api/cases' && r.request().method() === 'POST',
      );
      await staff.getByRole('button', { name: '登録する', exact: true }).click();
      const created = await (await createdResponse).json();
      await staff.getByRole('dialog').waitFor();
      const bride = created.invitations.find((i) => i.targetPartnerRole === 'bride');
      const sendResponse = staff.waitForResponse(
        (r) => r.url() === origin + `/api/cases/${created.caseId}/invitations/${bride.id}/send`,
      );
      await staff
        .getByRole('dialog')
        .locator('li')
        .filter({ hasText: '新婦' })
        .getByRole('button', { name: 'メールで送信', exact: true })
        .click();
      assert.equal((await sendResponse).status(), 200);
      const mailed = (
        await (await staff.request.get(origin + '/api/dev/mailbox')).json()
      ).messages.find((m) => m.kind === 'invitation' && m.email === email);
      assert.ok(mailed?.url);
      await couple.goto(mailed.url);
      await couple.getByLabel('メールアドレス', { exact: true }).fill(email);
      await couple.getByLabel('お名前', { exact: true }).fill('本人確認 花子');
      await couple.getByRole('checkbox').check();
      await couple.getByRole('button', { name: '登録してマイページへ', exact: true }).click();
      await couple.getByLabel('ワンタイムコード 1桁目').waitFor();
      const otp = (
        await (await staff.request.get(origin + '/api/dev/mailbox')).json()
      ).messages.find((m) => m.kind === 'otp' && m.email === email).code;
      for (let i = 0; i < 6; i++)
        await couple.getByLabel(`ワンタイムコード ${i + 1}桁目`).fill(otp[i]);
      await couple.waitForURL('**/mypage');
      await couple.getByRole('heading', { name: '次にやること', exact: true }).waitFor();
      assert.equal((await couple.locator('body').innerText()).includes('画面検証 花子'), true);
      assert.equal((await couple.request.get(origin + '/api/cases')).status(), 403);
      assert.equal(
        (await couple.request.get(origin + `/api/mypage/case?caseId=${ids.caseB}`)).status(),
        404,
      );
      await couple.reload();
      await couple.getByRole('button', { name: 'ログアウト', exact: true }).click();
      await couple.waitForURL('**/login');
      await couple.getByLabel('メールアドレス', { exact: true }).fill(email);
      // 待ち時間を短縮するため、ローカル検証用DBの認証試行履歴を期限外へ進める。
      const platform = await getPlatformProxy({
        configPath: 'cloudflare/wrangler.jsonc',
        persist: { path: '.wrangler/app-local/v3' },
      });
      try {
        await platform.env.DB.prepare('UPDATE app_auth_limits SET window_start=0').run();
      } finally {
        await platform.dispose();
      }
      await couple.getByRole('button', { name: '確認コードを送信', exact: true }).click();
      await couple.getByLabel('ワンタイムコード 1桁目').waitFor();
      const newOtp = (
        await (await staff.request.get(origin + '/api/dev/mailbox')).json()
      ).messages.find((m) => m.kind === 'otp' && m.email === email).code;
      for (let i = 0; i < 6; i++)
        await couple.getByLabel(`ワンタイムコード ${i + 1}桁目`).fill(newOtp[i]);
      await couple.waitForURL('**/mypage');
      const own = await (await couple.request.get(origin + '/api/mypage/case')).json();
      assert.equal(own.id, created.caseId);
      await mkdir('.wrangler/app-local/evidence', { recursive: true });
      await couple.screenshot({
        path: '.wrangler/app-local/evidence/onboarding-mypage.png',
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await writeFile(
        '.wrangler/app-local/evidence/onboarding-result.json',
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            caseCreated: true,
            invitationCapturedLocally: true,
            initialOtpVerified: true,
            otpRelogin: true,
            ownCaseOnly: true,
            externalRequests: external,
            pageErrors: errors,
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
