import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import {
  createStaff,
  updateStaff,
  deleteStaff,
  listStaff,
  managedStaff,
  passwordResettable,
  completePasswordSetup,
} from '../../src/lib/d1/staff.ts';
import { createD1Auth } from '../../src/lib/d1/auth.ts';
import { readMailbox } from '../../src/lib/d1/mailbox.ts';

let platform, db, auth, seeded;
const actor = (id, role, venueId) => ({
  id,
  role,
  venueId,
  authUserId: id,
  displayName: '検証',
  email: 'staff@example.test',
});
const system = actor(ids.system, 'system_admin', null);
const adminA = actor(ids.adminA, 'admin', ids.venueA);
const status = (error, code) => error?.code === code;
const tokenFor = async (email) => {
  const mail = (await readMailbox(db)).find((m) => m.email === email && m.kind === 'password');
  return new URL(mail.url).hash.replace('#token=', '');
};
const signIn = (email, password) =>
  auth.handler(
    new Request('http://127.0.0.1:3104/api/auth/sign-in/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:3104',
        'x-nicomaru-local-ip': randomUUID(),
      },
      body: JSON.stringify({ email, password }),
    }),
  );
const newPlanner = async () => {
  const email = `${randomUUID()}@example.test`;
  const created = await createStaff(db, adminA, {
    displayName: '新人 一郎',
    email,
    phone: '090-1234-5678',
  });
  return { ...created, email };
};

before(async () => {
  process.env.NICOMARU_DB = 'd1-local';
  process.env.APP_BASE_URL = 'http://127.0.0.1:3104';
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex');
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.PII_HMAC_KEY = randomBytes(32).toString('base64');
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
  seeded = await seedAppFixtures(db, encryptPii);
  auth = createD1Auth(db);
});
after(async () => {
  await platform?.dispose();
});

test('admin は自式場の planner だけを作り、初回設定リンクでログインできるようになる', async () => {
  const { user, email } = await newPlanner();
  assert.equal(user.role, 'planner');
  assert.equal(user.status, 'invited');
  const row = await managedStaff(db, adminA, user.id);
  assert.equal(row.venue_id, ids.venueA);
  assert.equal(row.phone, '090-1234-5678');
  const stored = await db
    .prepare('SELECT phone FROM user_profiles WHERE id=?')
    .bind(user.id)
    .first();
  assert.notEqual(stored.phone, '090-1234-5678', '電話番号は暗号化して保存する');

  const token = await tokenFor(email);
  await assert.rejects(completePasswordSetup(db, 'invalid-token', 'x'.repeat(12)), (e) =>
    status(e, 'UNPROCESSABLE'),
  );
  await completePasswordSetup(db, token, 'correct-horse-battery');
  const profile = await db
    .prepare('SELECT status FROM user_profiles WHERE id=?')
    .bind(user.id)
    .first();
  assert.equal(profile.status, 'active');
  assert.equal((await signIn(email, 'correct-horse-battery')).status, 200);
  // 同じリンクは2度使えない。
  await assert.rejects(completePasswordSetup(db, token, 'another-password-1'), (e) =>
    status(e, 'UNPROCESSABLE'),
  );
});

test('system_admin は指定式場に admin を作る。式場未指定・重複メールは拒否する', async () => {
  const email = `${randomUUID()}@example.test`;
  await assert.rejects(createStaff(db, system, { displayName: '管理 次郎', email }), (e) =>
    status(e, 'UNPROCESSABLE'),
  );
  const created = await createStaff(db, system, {
    displayName: '管理 次郎',
    email,
    venueId: ids.venueB,
  });
  assert.equal(created.user.role, 'admin');
  await assert.rejects(
    createStaff(db, adminA, { displayName: '重複', email: email.toUpperCase() }),
    (e) => status(e, 'CONFLICT'),
  );
});

test('一覧と管理範囲は式場で分かれ、新郎新婦は含まない', async () => {
  const { rows } = await listStaff(db, adminA, {});
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.venue_id === ids.venueA && r.role !== 'couple'));
  const all = await listStaff(db, system, { keyword: 'planner' });
  assert.ok(all.rows.some((r) => r.venue_id === ids.venueB));
  assert.equal(
    (await listStaff(db, adminA, { keyword: '%' })).rows.length,
    0,
    '% は文字として扱う',
  );
  await assert.rejects(managedStaff(db, adminA, ids.plannerB), (e) => status(e, 'NOT_FOUND'));
  await assert.rejects(managedStaff(db, adminA, ids.adminA), (e) => status(e, 'NOT_FOUND'));
  await assert.rejects(managedStaff(db, adminA, ids.coupleA), (e) => status(e, 'NOT_FOUND'));
  await assert.rejects(updateStaff(db, adminA, ids.plannerB, { displayName: '乗っ取り' }), (e) =>
    status(e, 'NOT_FOUND'),
  );
});

test('停止すると発行済みセッションが消え、ログインできない。再送は招待中だけ', async () => {
  await assert.rejects(updateStaff(db, adminA, ids.plannerA2, { resendInviteLink: true }), (e) =>
    status(e, 'UNPROCESSABLE'),
  );
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES ('s-a2',?,?,?,?,?)",
    )
    .bind(Date.now() + 3600e3, randomUUID(), Date.now(), Date.now(), ids.plannerA2)
    .run();
  const result = await updateStaff(db, adminA, ids.plannerA2, { status: 'suspended' });
  assert.equal(result.status, 'suspended');
  const left = await db
    .prepare('SELECT count(*) n FROM session WHERE userId=?')
    .bind(ids.plannerA2)
    .first();
  assert.equal(left.n, 0);
  const { email, password } = seeded.users.plannerA2;
  assert.notEqual((await signIn(email, password)).status, 200);
  await updateStaff(db, adminA, ids.plannerA2, { status: 'active' });
  assert.equal((await signIn(email, password)).status, 200);
  const { user, email: invitedEmail } = await newPlanner();
  const resent = await updateStaff(db, adminA, user.id, { resendInviteLink: true });
  assert.equal(resent.mailDelivered, false, 'ローカル検証は受信箱に保存する');
  assert.ok(await tokenFor(invitedEmail));
});

test('メール変更は重複を拒否し、変更後は未確認に戻る', async () => {
  const { user } = await newPlanner();
  await assert.rejects(updateStaff(db, adminA, user.id, { email: 'plannera@example.test' }), (e) =>
    status(e, 'CONFLICT'),
  );
  const email = `${randomUUID()}@example.test`;
  await updateStaff(db, adminA, user.id, { email, displayName: '改名 一郎' });
  const row = await managedStaff(db, adminA, user.id);
  assert.equal(row.email, email);
  assert.equal(row.display_name, '改名 一郎');
  const logged = await db
    .prepare("SELECT count(*) n FROM audit_logs WHERE action='user.update' AND target_id=?")
    .bind(user.id)
    .first();
  assert.equal(logged.n, 1);
});

test('読んだ後に他の操作で停止された利用者を、古い値で利用中に戻さない', async () => {
  const { user } = await newPlanner();
  // 読み取りと書き込みの間に、別の管理者の停止が確定した場合を再現する。
  const racing = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      await updateStaff(db, adminA, user.id, { status: 'suspended' });
      return db.batch(statements);
    },
  };
  await assert.rejects(updateStaff(racing, adminA, user.id, { displayName: '上書き' }), (e) =>
    status(e, 'CONFLICT'),
  );
  const row = await managedStaff(db, adminA, user.id);
  assert.equal(row.status, 'suspended');
  assert.equal(row.display_name, '新人 一郎');
});

test('編集中に初回設定が完了しても、招待中の古い状態で書き戻さない', async () => {
  const { user, email } = await newPlanner();
  const token = await tokenFor(email);
  const racing = {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      await completePasswordSetup(db, token, 'finished-during-edit');
      return db.batch(statements);
    },
  };
  await assert.rejects(updateStaff(racing, adminA, user.id, { displayName: '上書き' }), (e) =>
    status(e, 'CONFLICT'),
  );
  assert.equal((await managedStaff(db, adminA, user.id)).status, 'active');
  assert.equal((await signIn(email, 'finished-during-edit')).status, 200);
});

test('メール変更・停止・削除の後は、旧宛先へ送った設定リンクを使えない', async () => {
  for (const change of [
    (id) => updateStaff(db, adminA, id, { email: `${randomUUID()}@example.test` }),
    (id) => updateStaff(db, adminA, id, { status: 'suspended' }),
    (id) => deleteStaff(db, adminA, id),
  ]) {
    const { user, email } = await newPlanner();
    const token = await tokenFor(email);
    await change(user.id);
    await assert.rejects(completePasswordSetup(db, token, 'leaked-link-password'), (e) =>
      status(e, 'UNPROCESSABLE'),
    );
  }
  // 宛先を変えない更新では、設定リンクは有効なまま。
  const { user, email } = await newPlanner();
  const token = await tokenFor(email);
  await updateStaff(db, adminA, user.id, { displayName: '改名 二郎' });
  await completePasswordSetup(db, token, 'still-valid-password');
});

test('担当案件のある planner は引き継ぎ先なしでは削除できず、指定すると案件を移して論理削除する', async () => {
  await assert.rejects(deleteStaff(db, adminA, ids.adminA), (e) => status(e, 'UNPROCESSABLE'));
  await assert.rejects(deleteStaff(db, adminA, ids.plannerA), (e) => status(e, 'UNPROCESSABLE'));
  await assert.rejects(deleteStaff(db, adminA, ids.plannerA, ids.plannerB), (e) =>
    status(e, 'UNPROCESSABLE'),
  );
  await assert.rejects(deleteStaff(db, adminA, ids.plannerA, ids.suspended), (e) =>
    status(e, 'UNPROCESSABLE'),
  );
  await deleteStaff(db, adminA, ids.plannerA, ids.plannerA2);
  const moved = await db
    .prepare('SELECT primary_planner_id FROM wedding_cases WHERE id=?')
    .bind(ids.caseA)
    .first();
  assert.equal(moved.primary_planner_id, ids.plannerA2);
  const profile = await db
    .prepare('SELECT status FROM user_profiles WHERE id=?')
    .bind(ids.plannerA)
    .first();
  assert.equal(profile.status, 'deleted');
  await deleteStaff(db, adminA, ids.plannerA);
  await assert.rejects(updateStaff(db, adminA, ids.plannerA, { displayName: 'x' }), (e) =>
    status(e, 'NOT_FOUND'),
  );
});

test('パスワード再設定は職員だけが対象で、再設定後は旧パスワードと旧セッションが無効になる', async () => {
  assert.equal(await passwordResettable(db, 'couplea@example.test'), false);
  assert.equal(await passwordResettable(db, 'suspended@example.test'), false);
  assert.equal(await passwordResettable(db, 'ADMINA@example.test'), true);
  await auth.api.requestPasswordReset({ body: { email: 'admina@example.test' } });
  await db
    .prepare(
      "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES ('s-admin',?,?,?,?,?)",
    )
    .bind(Date.now() + 3600e3, randomUUID(), Date.now(), Date.now(), ids.adminA)
    .run();
  await completePasswordSetup(db, await tokenFor('admina@example.test'), 'new-admin-password');
  const left = await db
    .prepare('SELECT count(*) n FROM session WHERE userId=?')
    .bind(ids.adminA)
    .first();
  assert.equal(left.n, 0);
  assert.equal((await signIn('admina@example.test', 'new-admin-password')).status, 200);
});
