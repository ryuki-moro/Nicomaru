import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import {
  createCase,
  assignTasks,
  issueInvitation,
  listInvitations,
  registerCouple,
  otpEligible,
} from '../../src/lib/d1/onboarding.ts';
import { caseRow } from '../../src/lib/d1/cases.ts';
import { createD1Auth } from '../../src/lib/d1/auth.ts';
import { readMailbox } from '../../src/lib/d1/mailbox.ts';
import { authLimit } from '../../src/lib/d1/auth-limits.ts';

let platform, db, auth;
const actor = (id, role = 'planner', venueId = ids.venueA) => ({
  id,
  role,
  venueId,
  authUserId: id,
  displayName: '検証',
  email: 'staff@example.test',
});
const planner = actor(ids.plannerA);
const input = (email) => ({
  weddingDate: '2028-06-20',
  groomName: '登録 太郎',
  brideName: '登録 花子',
  contactEmail: email,
  primaryContact: 'bride',
  contactChannel: 'email',
  planTypeId: ids.planA,
  guestCount: 60,
});
const token = (inv) => new URL(inv.url).pathname.split('/').at(-1);
const registration = (inv, email) => ({
  token: token(inv),
  email,
  fullName: '本人 花子',
  termsAccepted: true,
});
const fresh = async () => {
  const email = `${randomUUID()}@example.test`;
  const created = await createCase(db, planner, input(email));
  return { created, email, inv: created.invitations.find((i) => i.targetPartnerRole === 'bride') };
};
const verify = async (email, code) =>
  auth.handler(
    new Request('http://127.0.0.1:3104/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3104',
        'x-nicomaru-local-ip': '127.0.0.1',
      },
      body: JSON.stringify({ email, otp: code }),
    }),
  );
async function send(email) {
  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
  return (await readMailbox(db)).find((m) => m.email === email && m.kind === 'otp').code;
}
before(async () => {
  process.env.APP_BASE_URL = 'http://127.0.0.1:3104';
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.PII_HMAC_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of ['0001_auth.sql', '0002_cases.sql', '0003_onboarding.sql']) {
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
  // 模擬データの式場はマイグレーション後に追加するためコードを明示する。
  await db
    .prepare("UPDATE venues SET code=CASE WHEN id=? THEN 'VENUEA' ELSE 'VENUEB' END")
    .bind(ids.venueA)
    .run();
  auth = createD1Auth(db);
});
after(async () => {
  await platform?.dispose();
});

test('案件登録は自式場・自身担当で2招待を発行し、宿題割当は冪等', async () => {
  const { created, inv } = await fresh();
  const row = await caseRow(db, planner, created.caseId);
  assert.equal(row.venue_id, ids.venueA);
  assert.equal(row.primary_planner_id, ids.plannerA);
  assert.match(created.caseCode, /^VENUEA-2028-\d{4}$/);
  assert.equal(created.invitations.length, 2);
  const invitations = (await listInvitations(db, planner, created.caseId)).invitations;
  assert.equal(invitations.find((i) => i.targetPartnerRole === 'bride').hasEmail, true);
  assert.equal(invitations.find((i) => i.targetPartnerRole === 'groom').hasEmail, false);
  const stored = await db
    .prepare('SELECT token_hash FROM case_invitations WHERE id=?')
    .bind(inv.id)
    .first();
  assert.notEqual(stored.token_hash, token(inv));
  assert.equal(stored.token_hash.length, 64);
  assert.equal((await assignTasks(db, planner, created.caseId)).added, 1);
  assert.equal((await assignTasks(db, planner, created.caseId)).added, 0);
  await assert.rejects(
    createCase(db, planner, { ...input('test@example.test'), planTypeId: ids.planB }),
    { code: 'VALIDATION_ERROR' },
  );
  await assert.rejects(createCase(db, actor(ids.coupleA, 'couple'), input('test@example.test')), {
    code: 'FORBIDDEN',
  });
});
test('同時登録でも採番は重複せず、子行のDB例外は採番・案件も巻き戻す', async () => {
  const created = await Promise.all([fresh(), fresh()]);
  assert.notEqual(created[0].created.caseCode, created[1].created.caseCode);
  const before = await db.prepare('SELECT count(*) AS n FROM wedding_cases').first();
  const counter = await db
    .prepare('SELECT value FROM case_counters WHERE venue_id=? AND year=2028')
    .bind(ids.venueA)
    .first();
  await db
    .prepare(
      "CREATE TRIGGER fail_new_invite BEFORE INSERT ON case_invitations BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    )
    .run();
  try {
    await assert.rejects(fresh());
  } finally {
    await db.prepare('DROP TRIGGER fail_new_invite').run();
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM wedding_cases').first()).n, before.n);
  assert.equal(
    (
      await db
        .prepare('SELECT value FROM case_counters WHERE venue_id=? AND year=2028')
        .bind(ids.venueA)
        .first()
    ).value,
    counter.value,
  );
});
test('初回登録はOTP確認まで未連携、確認後だけ招待を消費して本人の案件へ連携', async () => {
  const { created, email, inv } = await fresh(),
    data = registration(inv, email);
  assert.equal((await registerCouple(db, data, null)).status, 'verification_required');
  assert.equal(
    (
      await db
        .prepare("SELECT user_id FROM couple_profiles WHERE case_id=? AND partner_role='bride'")
        .bind(created.caseId)
        .first()
    ).user_id,
    null,
  );
  assert.equal(
    (await db.prepare('SELECT use_count FROM case_invitations WHERE id=?').bind(inv.id).first())
      .use_count,
    0,
  );
  const code = await send(email),
    response = await verify(email, code);
  assert.equal(response.status, 200);
  const user = (await response.json()).user;
  assert.equal((await registerCouple(db, data, user)).status, 'registered');
  assert.equal(
    (await caseRow(db, actor(user.id, 'couple'), created.caseId)).couple_profiles.find(
      (p) => p.partner_role === 'bride',
    ).full_name,
    '登録 花子',
  );
  await assert.rejects(registerCouple(db, data, user), { code: 'UNPROCESSABLE' });
  await assert.rejects(caseRow(db, actor(user.id, 'couple'), ids.caseB), { code: 'NOT_FOUND' });
  assert.equal((await verify(email, code)).ok, false);
});
test('期限切れ・失効・宛先不一致の招待ではユーザーも作らず、再発行は旧URLを無効化', async () => {
  const { created, email, inv } = await fresh();
  const count = await db.prepare('SELECT count(*) AS n FROM "user"').first();
  await assert.rejects(registerCouple(db, registration(inv, 'different@example.test'), null), {
    code: 'UNPROCESSABLE',
  });
  await db
    .prepare("UPDATE case_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .bind(inv.id)
    .run();
  await assert.rejects(registerCouple(db, registration(inv, email), null), {
    code: 'UNPROCESSABLE',
  });
  assert.equal((await db.prepare('SELECT count(*) AS n FROM "user"').first()).n, count.n);
  const next = await issueInvitation(db, planner, created.caseId, 'bride', 'email', inv.id);
  assert.equal(next.delivered, false);
  assert.equal(next.sentAt, null);
  assert.notEqual(next.url, inv.url);
  assert.equal((await listInvitations(db, planner, created.caseId)).invitations.length, 2);
  await assert.rejects(registerCouple(db, registration(inv, email), null), {
    code: 'UNPROCESSABLE',
  });
  const mail = (await readMailbox(db)).find((m) => m.url === next.url);
  assert.equal(mail.kind, 'invitation');
  await assert.rejects(
    issueInvitation(db, actor(ids.adminB, 'admin', ids.venueB), created.caseId, 'bride'),
    { code: 'NOT_FOUND' },
  );
  await assert.rejects(issueInvitation(db, actor(ids.coupleA, 'couple'), created.caseId, 'bride'), {
    code: 'FORBIDDEN',
  });
});
test('宛先未設定の新郎もOTPで本人確認し、同時の招待消費は1件だけ成功', async () => {
  const { created } = await fresh(),
    email = `groom-${randomUUID()}@example.test`;
  const inv = created.invitations.find((i) => i.targetPartnerRole === 'groom'),
    data = registration(inv, email);
  await registerCouple(db, data, null);
  const code = await send(email),
    response = await verify(email, code),
    user = (await response.json()).user;
  const results = await Promise.allSettled([
    registerCouple(db, data, user),
    registerCouple(db, data, user),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (await db.prepare('SELECT use_count FROM case_invitations WHERE id=?').bind(inv.id).first())
      .use_count,
    1,
  );
});
test('OTPはHMAC、受信箱は暗号化して保存し、同時検証・再利用・期限切れを拒否', async () => {
  const { email, inv } = await fresh();
  await registerCouple(db, registration(inv, email), null);
  const code = await send(email);
  const stored = await db
    .prepare('SELECT value FROM verification WHERE identifier=?')
    .bind(`sign-in-otp-${email}`)
    .first();
  assert.ok(stored);
  assert.equal(stored.value.includes(code), false);
  const mailbox = await db
    .prepare('SELECT payload FROM local_mailbox ORDER BY rowid DESC LIMIT 1')
    .first();
  assert.match(mailbox.payload, /^v1:/);
  const results = await Promise.all([verify(email, code), verify(email, code)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await verify(email, code)).ok, false);
  const next = await send(email);
  await db
    .prepare('UPDATE verification SET expiresAt=0 WHERE identifier=?')
    .bind(`sign-in-otp-${email}`)
    .run();
  assert.equal((await verify(email, next)).ok, false);
});
test('OTP誤り5回で失効し、再送時に旧コードを無効化する', async () => {
  const { email, inv } = await fresh();
  await registerCouple(db, registration(inv, email), null);
  const code = await send(email),
    wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await verify(email, wrong)).ok, false);
  assert.equal((await verify(email, code)).ok, false);
  const replacement = await send(email);
  assert.notEqual(code, replacement);
  assert.equal((await verify(email, code)).ok, false);
  assert.equal((await verify(email, replacement)).ok, true);
});
test('未登録メールでOTPアカウントを自動作成せず、停止済み・スタッフは対象外', async () => {
  const email = `unknown-${randomUUID()}@example.test`;
  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
  assert.equal(await db.prepare('SELECT id FROM "user" WHERE email=?').bind(email).first(), null);
  assert.equal(
    (await readMailbox(db)).some((m) => m.email === email),
    false,
  );
  assert.equal(await otpEligible(db, 'admina@example.test'), false);
  await db
    .prepare("UPDATE user_profiles SET status='suspended' WHERE id=?")
    .bind(ids.coupleA)
    .run();
  try {
    assert.equal(await otpEligible(db, 'couplea@example.test'), false);
  } finally {
    await db.prepare("UPDATE user_profiles SET status='active' WHERE id=?").bind(ids.coupleA).run();
  }
});
test('OTP発行後にスタッフへ変更された利用者はOTPでセッションを作れない', async () => {
  const { email, inv } = await fresh();
  await registerCouple(db, registration(inv, email), null);
  const code = await send(email);
  const user = await db.prepare('SELECT id FROM "user" WHERE email=?').bind(email).first();
  await db.prepare("UPDATE user_profiles SET role='admin' WHERE id=?").bind(user.id).run();
  assert.equal((await verify(email, code)).ok, false);
  assert.equal(
    (await db.prepare('SELECT count(*) AS n FROM session WHERE userId=?').bind(user.id).first()).n,
    0,
  );
});
test('再送60秒・1時間5回・検証20回の制限をD1で保持', async () => {
  const email = `limit-${randomUUID()}@example.test`;
  await authLimit(db, 'otp_request', email);
  await assert.rejects(authLimit(db, 'otp_request', email), { code: 'RATE_LIMITED' });
  for (let i = 0; i < 4; i++)
    await assert.rejects(authLimit(db, 'otp_request', email), { code: 'RATE_LIMITED' });
  for (let i = 0; i < 20; i++) await authLimit(db, 'otp_verify', email);
  await assert.rejects(authLimit(db, 'otp_verify', email), { code: 'RATE_LIMITED' });
});
