import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import { createCase, issueInvitation } from '../../src/lib/d1/onboarding.ts';
import { createNotification } from '../../src/lib/d1/notifications.ts';
import { createD1Auth } from '../../src/lib/d1/auth.ts';

// 本番D1（NICOMARU_DB=d1）ではローカル受信箱へ保存せず、Resendへ送信する。
let platform, db;
let mails = [];
let failNext = false;
let beforeReply = null;
const realFetch = globalThis.fetch;
const planner = {
  id: ids.plannerA,
  role: 'planner',
  venueId: ids.venueA,
  authUserId: ids.plannerA,
  displayName: '検証',
  email: 'staff@example.test',
};
const mailboxCount = async () =>
  (await db.prepare('SELECT count(*) AS n FROM local_mailbox').first()).n;
before(async () => {
  Object.assign(process.env, {
    NICOMARU_DB: 'd1',
    APP_BASE_URL: 'https://nicomaru.example.test',
    RESEND_API_KEY: 're_test',
    RESEND_FROM: 'noreply@example.test',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    PII_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PII_HMAC_KEY: randomBytes(32).toString('base64'),
  });
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.resend.com/')) return realFetch(url, init);
    if (failNext) {
      failNext = false;
      return new Response('error', { status: 500 });
    }
    mails.push(JSON.parse(init.body));
    await beforeReply?.();
    return Response.json({ id: `msg_${mails.length}` });
  };
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of (await readdir('cloudflare/migrations')).sort()) {
    const sql = await readFile(`cloudflare/migrations/${file}`, 'utf8');
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  await seedAppFixtures(db, encryptPii);
  await db
    .prepare("UPDATE venues SET code=CASE WHEN id=? THEN 'VENUEA' ELSE 'VENUEB' END")
    .bind(ids.venueA)
    .run();
});
afterEach(() => {
  mails = [];
  failNext = false;
  beforeReply = null;
});
after(async () => {
  globalThis.fetch = realFetch;
  await platform?.dispose();
});

const newCase = (email) =>
  createCase(db, planner, {
    weddingDate: '2028-06-20',
    groomName: '送信 太郎',
    brideName: '送信 花子',
    contactEmail: email,
    primaryContact: 'bride',
    contactChannel: 'email',
    planTypeId: ids.planA,
    guestCount: 60,
  });

test('招待メールを外部送信し、送信日時を記録する', async () => {
  const email = `${randomUUID()}@example.test`;
  const { caseId } = await newCase(email);
  const issued = await issueInvitation(db, planner, caseId, 'bride', 'email');
  assert.equal(issued.delivered, true);
  assert.ok(issued.sentAt);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, [email]);
  assert.ok(mails[0].text.includes(issued.url));
  assert.match(issued.url, /^https:\/\/nicomaru\.example\.test\/register\//);
  const row = await db
    .prepare('SELECT sent_at FROM case_invitations WHERE id=?')
    .bind(issued.id)
    .first();
  assert.equal(row.sent_at, issued.sentAt);
  assert.equal(await mailboxCount(), 0);
});

test('送信に失敗しても発行済みの招待URLを返し、送信済みにしない', async () => {
  const { caseId } = await newCase(`${randomUUID()}@example.test`);
  failNext = true;
  const issued = await issueInvitation(db, planner, caseId, 'bride', 'email');
  assert.equal(issued.delivered, false);
  assert.equal(issued.sentAt, null);
  assert.match(issued.skippedReason, /送信に失敗/);
  assert.ok(issued.url);
});

test('宛先未設定の招待は送信せず理由を返す', async () => {
  const { caseId } = await newCase(`${randomUUID()}@example.test`);
  const issued = await issueInvitation(db, planner, caseId, 'groom', 'email');
  assert.equal(issued.delivered, false);
  assert.equal(mails.length, 0);
  assert.match(issued.skippedReason, /メールアドレスが登録されていません/);
});

test('確認コードをメールで送り、受信箱には保存しない', async () => {
  await createD1Auth(db).api.sendVerificationOTP({
    body: { email: 'couplea@example.test', type: 'sign-in' },
  });
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['couplea@example.test']);
  assert.match(mails[0].text, /確認コード: \d{6}/);
  assert.equal(await mailboxCount(), 0);
});

test('メール通知を送信し、状態をsentにしてリンクを付ける', async () => {
  const result = await createNotification(db, planner, {
    caseId: ids.caseA,
    recipientUserId: ids.coupleA,
    channel: 'email',
    notificationType: 'info',
    message: 'ご確認ください',
  });
  assert.equal(result.delivered, true);
  assert.equal(mails.length, 1);
  assert.match(
    mails[0].text,
    /マイページで確認する: https:\/\/nicomaru\.example\.test\/mypage\/tasks$/,
  );
  const row = await db
    .prepare('SELECT status,sent_at FROM notifications WHERE id=?')
    .bind(result.notificationId)
    .first();
  assert.equal(row.status, 'sent');
  assert.ok(row.sent_at);
});

test('送信中に既読化されても送信日時を残し、既読を維持する', async () => {
  beforeReply = () =>
    db
      .prepare("UPDATE notifications SET read_at=?,status='read' WHERE status='pending'")
      .bind(new Date().toISOString())
      .run();
  const result = await createNotification(db, planner, {
    caseId: ids.caseA,
    recipientUserId: ids.coupleA,
    channel: 'email',
    notificationType: 'info',
    message: '既読の競合',
  });
  const row = await db
    .prepare('SELECT status,sent_at FROM notifications WHERE id=?')
    .bind(result.notificationId)
    .first();
  assert.equal(row.status, 'read');
  assert.ok(row.sent_at);
});
