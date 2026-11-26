import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { encryptPii } from '../../src/lib/crypto.ts';
import { seedDemoFixtures } from '../../scripts/d1-demo-fixtures.mjs';
import { DEMO_CASES } from '../../scripts/demo/scenario.ts';
import { listMessages, unreadCounts } from '../../src/lib/d1/messages.ts';

const VENUE_ID = '11111111-1111-4111-8111-111111111111';
const PLANNER_ID = '41111111-1111-4111-8111-111111111111';
const caseId = (key) =>
  `51111111-0000-4000-8000-${String(DEMO_CASES.findIndex((c) => c.key === key) + 1).padStart(12, '0')}`;
const actor = (role, id) => ({
  id,
  role,
  venueId: VENUE_ID,
  authUserId: id,
  displayName: '検証',
  email: 'test@example.test',
});

let platform;
before(async () => {
  process.env.NICOMARU_DB = 'd1-local';
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  const db = platform.env.DB;
  for (const file of (await readdir('cloudflare/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = await readFile(`cloudflare/migrations/${file}`, 'utf8');
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  await seedDemoFixtures(db, encryptPii, 'demo-password', platform.env.FILES);
});
after(async () => {
  await platform?.dispose();
});

test('デモのチャット: 主役の案件に会話が入り、本文は復号でき、担当者の最後の1通だけが新郎新婦の未読になる', async () => {
  const db = platform.env.DB;
  const id = caseId('demo-02');
  const expected = DEMO_CASES.find((c) => c.key === 'demo-02').messages;
  const { results } = await db
    .prepare('SELECT body_enc FROM case_messages WHERE case_id=?')
    .bind(id)
    .all();
  assert.equal(results.length, expected.length);
  assert.ok(
    results.every((r) => !expected.some((m) => r.body_enc.includes(m.body))),
    '平文で保存されている',
  );

  const planner = actor('planner', PLANNER_ID);
  const { items } = await listMessages(db, planner, id, { limit: 50 });
  assert.deepEqual(
    items.map((m) => m.body),
    expected.map((m) => m.body),
  );
  const couple = actor('couple', items.find((m) => m.senderSide === 'couple').senderUserId);
  assert.equal((await unreadCounts(db, couple, [id]))[id], 1);
  assert.equal((await unreadCounts(db, planner, [id]))[id], 0);
});
