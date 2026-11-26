import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, request } from '@playwright/test';
import { getPlatformProxy } from 'wrangler';

const origin = 'http://127.0.0.1:3104';
const { users, ids } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));
const REALTIME_MS = 3000;
const BACKFILL_MS = 45000;

async function storageOf(name) {
  const context = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
  });
  try {
    const response = await context.post('/api/auth/password-login', { data: users[name] });
    assert.equal(response.status(), 200, `login ${name}`);
    return await context.storageState();
  } finally {
    await context.dispose();
  }
}

async function resetChat() {
  const platform = await getPlatformProxy({
    configPath: 'cloudflare/wrangler.jsonc',
    persist: { path: '.wrangler/app-local/v3' },
  });
  try {
    await platform.env.DB.batch([
      platform.env.DB.prepare('DELETE FROM rateLimit'),
      platform.env.DB.prepare('DELETE FROM case_messages WHERE case_id=?').bind(ids.caseA),
      platform.env.DB.prepare('DELETE FROM case_message_reads WHERE case_id=?').bind(ids.caseA),
    ]);
  } finally {
    await platform.dispose();
  }
}

async function send(page, text) {
  await page.getByLabel('メッセージ', { exact: true }).fill(text);
  // getByText は入力欄の中身にも当たるため、保存の完了は投稿APIの応答と履歴への表示で確かめる
  const posted = page.waitForResponse((r) => isMessages(r, 'POST'), { timeout: 30000 });
  await page.getByRole('button', { name: '送信', exact: true }).click();
  assert.equal((await posted).status(), 201);
  await page
    .getByRole('log', { name: 'メッセージの履歴' })
    .getByText(text, { exact: true })
    .waitFor({ timeout: 10000 });
}

function isMessages(response, method) {
  return (
    response.request().method() === method && new URL(response.url()).pathname.endsWith('/messages')
  );
}

test(
  'チャット: 投稿の即時反映・未読・返信・取り消し・オフライン後の取りこぼし取得',
  { timeout: 240000 },
  async () => {
    await resetChat();
    const browser = await chromium.launch({ headless: true });
    const errors = [];
    try {
      const open = async (name) => {
        const context = await browser.newContext({ storageState: await storageOf(name) });
        context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
        return { context, page: await context.newPage() };
      };
      const planner = await open('plannerA');
      const couple = await open('coupleA');
      const staffChat = `${origin}/cases/${ids.caseA}/chat`;
      const coupleChat = `${origin}/mypage/chat`;
      const tag = randomUUID().slice(0, 8);

      // 担当者の投稿は、新郎新婦がチャットを開く前はマイページ(M01)で未読になる
      await planner.page.goto(staffChat);
      const first = `ご連絡です ${tag}-1`;
      await send(planner.page, first);
      await couple.page.goto(`${origin}/mypage`);
      await couple.page.getByRole('img', { name: '未読1件' }).waitFor({ timeout: 30000 });

      // チャットを開くと既読になり、マイページの未読バッジが消える
      await couple.page.goto(coupleChat);
      await couple.page.getByText(first, { exact: true }).waitFor();
      await couple.page.waitForResponse((r) => r.url().includes('/messages/read'), {
        timeout: 10000,
      });
      await couple.page.goto(`${origin}/mypage`);
      await couple.page.getByRole('link', { name: 'プランナーとチャット' }).waitFor();
      assert.equal(await couple.page.getByRole('img', { name: /^未読/ }).count(), 0);

      // 開いたままの相手の画面へ、再読み込みなしで届く
      await couple.page.goto(coupleChat);
      await couple.page.getByText(first, { exact: true }).waitFor();
      const second = `次のご連絡です ${tag}-2`;
      await send(planner.page, second);
      await couple.page.getByText(second, { exact: true }).waitFor({ timeout: REALTIME_MS });

      // 新郎新婦の返信も担当者へ届く
      const reply = `承知しました ${tag}-3`;
      await send(couple.page, reply);
      await planner.page.getByText(reply, { exact: true }).waitFor({ timeout: REALTIME_MS });

      // 自分の投稿を取り消すと、相手には「取り消されました」と表示される
      const mine = planner.page.locator('div.flex.justify-end', { hasText: second });
      await mine.getByRole('button', { name: '取り消す' }).click();
      await mine
        .getByRole('group', { name: '取り消しの確認' })
        .getByRole('button', { name: '取り消す' })
        .click();
      await planner.page.getByText(second, { exact: true }).waitFor({ state: 'detached' });
      await couple.page
        .getByText(second, { exact: true })
        .waitFor({ state: 'detached', timeout: REALTIME_MS });
      assert.ok((await couple.page.getByText('メッセージは取り消されました').count()) >= 1);

      // オフラインの間の投稿は、復帰後に取りこぼし取得で表示される
      await couple.context.setOffline(true);
      const missed = `オフライン中の投稿 ${tag}-4`;
      await send(planner.page, missed);
      await couple.context.setOffline(false);
      await couple.page.getByText(missed, { exact: true }).waitFor({ timeout: BACKFILL_MS });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
