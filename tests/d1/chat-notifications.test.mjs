import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { encryptPii } from '../../src/lib/crypto.ts';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { notifyCouplesOfStaffMessage } from '../../src/lib/d1/chat-notifications.ts';

let platform;
let db;
const planner = {
  id: ids.plannerA,
  role: 'planner',
  venueId: ids.venueA,
  authUserId: ids.plannerA,
  displayName: '担当',
  email: 'planner@example.test',
};
const count = async (sql, ...binds) =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .first()
  ).n;
const chatRows = (channel) =>
  count(
    "SELECT count(*) AS n FROM notifications WHERE case_id=? AND notification_type='chat_message' AND channel=?",
    ids.caseA,
    channel,
  );

before(async () => {
  process.env.NICOMARU_DB = 'd1-local';
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  const files = (await readdir('cloudflare/migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
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
});
after(async () => {
  await platform?.dispose();
});

test('担当者の投稿でアプリ内通知を作り、未読が残る間はメール(ローカル受信箱)を重ねない', async () => {
  const members = await count(
    "SELECT count(*) AS n FROM couple_profiles cp JOIN user_profiles r ON r.id=cp.user_id AND r.status='active' AND r.role='couple' WHERE cp.case_id=?",
    ids.caseA,
  );
  assert.ok(members >= 1);
  const mailboxBefore = await count('SELECT count(*) AS n FROM local_mailbox');

  await notifyCouplesOfStaffMessage(db, planner, ids.caseA);
  assert.equal(await chatRows('in_app'), members);
  assert.equal((await count('SELECT count(*) AS n FROM local_mailbox')) - mailboxBefore, members);
  const row = await db
    .prepare(
      "SELECT body,link_path,status FROM notifications WHERE notification_type='chat_message' LIMIT 1",
    )
    .first();
  assert.equal(row.link_path, '/mypage/chat');
  assert.equal(row.status, 'sent');

  // 未読のまま続けて投稿: アプリ内通知は増えるがメールは増えない
  await notifyCouplesOfStaffMessage(db, planner, ids.caseA);
  assert.equal(await chatRows('in_app'), members * 2);
  assert.equal((await count('SELECT count(*) AS n FROM local_mailbox')) - mailboxBefore, members);

  // 既読にした後の投稿ではメールが再び送られる
  await db
    .prepare("UPDATE notifications SET read_at=? WHERE notification_type='chat_message'")
    .bind(new Date().toISOString())
    .run();
  await notifyCouplesOfStaffMessage(db, planner, ids.caseA);
  assert.equal(
    (await count('SELECT count(*) AS n FROM local_mailbox')) - mailboxBefore,
    members * 2,
  );
});

test('他の案件の新郎新婦には通知しない', async () => {
  const other = await count(
    "SELECT count(*) AS n FROM notifications WHERE notification_type='chat_message' AND case_id<>?",
    ids.caseA,
  );
  assert.equal(other, 0);
});
