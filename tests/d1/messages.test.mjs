import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { encryptPii } from '../../src/lib/crypto.ts';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { purgeCasesD1 } from '../../src/lib/d1/case-purge.ts';
import {
  MESSAGE_RETRACT_WINDOW_MS,
  decodeCursor,
  encodeCursor,
  listMessages,
  markRead,
  postMessage,
  retractMessage,
  unreadCounts,
} from '../../src/lib/d1/messages.ts';

let platform;
let db;
const actor = (role, id, venueId = ids.venueA) => ({
  id,
  role,
  venueId,
  authUserId: id,
  displayName: '検証',
  email: 'test@example.test',
});
const planner = () => actor('planner', ids.plannerA);
const admin = () => actor('admin', ids.adminA);
const bride = () => actor('couple', ids.coupleA);
const groomId = '10000000-0000-4000-8000-0000000000a1';
const groom = () => actor('couple', groomId);
const uuid = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString();

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
  // 新郎側のログインユーザー (fixtures は新婦だけ紐づく)
  await db.batch([
    db
      .prepare(
        'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)',
      )
      .bind(groomId, '新郎', 'groom@example.test'),
    db
      .prepare("INSERT INTO user_profiles(id,venue_id,role,status) VALUES (?,?,'couple','active')")
      .bind(groomId, ids.venueA),
    db
      .prepare("UPDATE couple_profiles SET user_id=? WHERE case_id=? AND partner_role='groom'")
      .bind(groomId, ids.caseA),
  ]);
});
after(async () => {
  await platform?.dispose();
});

const insertRaw = (caseId, n, sender, createdAt, body = `本文${n}`) =>
  db
    .prepare(
      'INSERT INTO case_messages(id,case_id,sender_user_id,body_enc,created_at) VALUES (?,?,?,?,?)',
    )
    .bind(uuid(n), caseId, sender, encryptPii(body), createdAt)
    .run();
const clearMessages = async () => {
  await db.prepare('DELETE FROM case_message_reads').run();
  await db.prepare('DELETE FROM case_messages').run();
};

test('案件の参加者は一覧と投稿ができ、送信者名と側が付く', async () => {
  await clearMessages();
  for (const u of [planner(), admin(), actor('system_admin', ids.system, null), bride(), groom()]) {
    const sent = await postMessage(db, u, ids.caseA, `こんにちは ${u.id}`);
    assert.equal(sent.mine, true);
    assert.equal(sent.body, `こんにちは ${u.id}`);
  }
  const { items, hasMore } = await listMessages(db, planner(), ids.caseA, { limit: 50 });
  assert.equal(items.length, 5);
  assert.equal(hasMore, false);
  const byId = Object.fromEntries(items.map((m) => [m.senderUserId, m]));
  assert.equal(byId[ids.plannerA].senderSide, 'staff');
  assert.equal(byId[ids.plannerA].senderName, 'plannerA');
  assert.equal(byId[ids.plannerA].mine, true);
  assert.equal(byId[ids.coupleA].senderSide, 'couple');
  assert.equal(byId[groomId].senderName, '新郎');
  assert.equal(byId[ids.coupleA].mine, false);
  assert.equal((await listMessages(db, groom(), ids.caseA, { limit: 50 })).items.length, 5);
});

test('参加者以外・停止ユーザー・別式場の管理者は 404', async () => {
  const outsiders = [
    actor('planner', ids.plannerA2),
    actor('couple', ids.coupleB, ids.venueB),
    actor('admin', ids.adminB, ids.venueB),
    actor('planner', ids.plannerB, ids.venueB),
  ];
  for (const u of outsiders) {
    await assert.rejects(listMessages(db, u, ids.caseA, { limit: 10 }), { status: 404 });
    await assert.rejects(postMessage(db, u, ids.caseA, 'x'), { status: 404 });
    await assert.rejects(markRead(db, u, ids.caseA, encodeCursor(iso(0), uuid(1))), {
      status: 404,
    });
  }
  await db
    .prepare("UPDATE user_profiles SET status='suspended' WHERE id=?")
    .bind(ids.plannerA)
    .run();
  try {
    await assert.rejects(listMessages(db, planner(), ids.caseA, { limit: 10 }), { status: 404 });
    await assert.rejects(postMessage(db, planner(), ids.caseA, 'x'), { status: 404 });
  } finally {
    await db
      .prepare("UPDATE user_profiles SET status='active' WHERE id=?")
      .bind(ids.plannerA)
      .run();
  }
  await assert.rejects(listMessages(db, planner(), crypto.randomUUID(), { limit: 10 }), {
    status: 404,
  });
});

test('アーカイブ済み案件は担当者・カップルは 404、管理者は閲覧のみ可能', async () => {
  await db
    .prepare("UPDATE wedding_cases SET archived_at='2026-01-01' WHERE id=?")
    .bind(ids.caseA)
    .run();
  try {
    for (const u of [planner(), bride(), groom()]) {
      await assert.rejects(listMessages(db, u, ids.caseA, { limit: 10 }), { status: 404 });
      await assert.rejects(postMessage(db, u, ids.caseA, 'x'), { status: 404 });
    }
    assert.ok((await listMessages(db, admin(), ids.caseA, { limit: 10 })).items.length > 0);
    await assert.rejects(postMessage(db, admin(), ids.caseA, 'x'), { status: 404 });
  } finally {
    await db.prepare('UPDATE wedding_cases SET archived_at=NULL WHERE id=?').bind(ids.caseA).run();
  }
});

test('本文は暗号化して保存される', async () => {
  const sent = await postMessage(db, planner(), ids.caseA, '平文の本文');
  const raw = await db
    .prepare('SELECT body_enc FROM case_messages WHERE id=?')
    .bind(sent.id)
    .first();
  assert.ok(raw.body_enc);
  assert.notEqual(raw.body_enc, '平文の本文');
  assert.ok(!raw.body_enc.includes('平文'));
  assert.equal(sent.body, '平文の本文');
});

test('カーソルの符号化と、after / before / 最新のページング', async () => {
  await clearMessages();
  const t = Date.UTC(2027, 0, 1, 0, 0, 0);
  // n=1..6、うち 3 と 4 は同時刻 (id で順序が決まる)
  const times = [0, 1000, 2000, 2000, 3000, 4000];
  for (const [i, off] of times.entries())
    await insertRaw(ids.caseA, i + 1, ids.plannerA, iso(t + off));
  const cursorOf = (n) => encodeCursor(iso(t + times[n - 1]), uuid(n));
  assert.deepEqual(decodeCursor(cursorOf(1)), { createdAt: iso(t), id: uuid(1) });
  const bodies = (r) => r.items.map((m) => m.body);

  const latest = await listMessages(db, bride(), ids.caseA, { limit: 4 });
  assert.deepEqual(bodies(latest), ['本文3', '本文4', '本文5', '本文6']);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.items[0].cursor, cursorOf(3));
  assert.equal((await listMessages(db, bride(), ids.caseA, { limit: 6 })).hasMore, false);

  const before = await listMessages(db, bride(), ids.caseA, { before: cursorOf(4), limit: 2 });
  assert.deepEqual(bodies(before), ['本文2', '本文3']);
  assert.equal(before.hasMore, true);
  const beforeAll = await listMessages(db, bride(), ids.caseA, { before: cursorOf(4), limit: 3 });
  assert.deepEqual(bodies(beforeAll), ['本文1', '本文2', '本文3']);
  assert.equal(beforeAll.hasMore, false);

  const after = await listMessages(db, bride(), ids.caseA, { after: cursorOf(3), limit: 2 });
  assert.deepEqual(bodies(after), ['本文4', '本文5']);
  assert.equal(after.hasMore, true);
  const afterAll = await listMessages(db, bride(), ids.caseA, { after: cursorOf(3), limit: 3 });
  assert.deepEqual(bodies(afterAll), ['本文4', '本文5', '本文6']);
  assert.equal(afterAll.hasMore, false);
  assert.deepEqual(
    (await listMessages(db, bride(), ids.caseA, { after: cursorOf(6), limit: 5 })).items,
    [],
  );
});

test('不正なカーソルは 400', async () => {
  const bad = [
    '',
    'x',
    'abc_def',
    `2027-01-01_${uuid(1)}`,
    `${iso(0)}_not-a-uuid`,
    `${iso(0)}_${uuid(1)}_x`,
  ];
  for (const cursor of bad) {
    assert.equal(decodeCursor(cursor), null, cursor);
    await assert.rejects(listMessages(db, bride(), ids.caseA, { after: cursor, limit: 5 }), {
      status: 400,
    });
  }
  await assert.rejects(listMessages(db, bride(), ids.caseA, { before: 'x_y', limit: 5 }), {
    status: 400,
  });
  await assert.rejects(markRead(db, bride(), ids.caseA, 'x'), { status: 400 });
  await assert.rejects(
    listMessages(db, bride(), ids.caseA, {
      after: encodeCursor(iso(0), uuid(1)),
      before: encodeCursor(iso(0), uuid(1)),
      limit: 5,
    }),
    { status: 400 },
  );
});

test('取り消しは本人だけ・時間内だけで、一覧では本文なしで残る', async () => {
  await clearMessages();
  const mine = await postMessage(db, planner(), ids.caseA, '消したい');
  const sentAt = Date.parse(mine.createdAt);
  await assert.rejects(retractMessage(db, bride(), mine.id), { status: 404 });
  await assert.rejects(retractMessage(db, admin(), mine.id), { status: 404 });
  await assert.rejects(retractMessage(db, actor('planner', ids.plannerA2), mine.id), {
    status: 404,
  });
  await assert.rejects(retractMessage(db, planner(), crypto.randomUUID()), { status: 404 });
  // 時間切れ
  await assert.rejects(
    retractMessage(db, planner(), mine.id, sentAt + MESSAGE_RETRACT_WINDOW_MS + 1),
    { status: 409 },
  );
  const out = await retractMessage(db, planner(), mine.id, sentAt + 1000);
  assert.deepEqual(out, { caseId: ids.caseA, cursor: mine.cursor });
  const raw = await db
    .prepare('SELECT body_enc,deleted_at FROM case_messages WHERE id=?')
    .bind(mine.id)
    .first();
  assert.equal(raw.body_enc, null);
  assert.ok(raw.deleted_at);
  const [item] = (await listMessages(db, bride(), ids.caseA, { limit: 5 })).items;
  assert.equal(item.retracted, true);
  assert.equal(item.body, null);
  // 二重の取り消しは状態競合
  await assert.rejects(retractMessage(db, planner(), mine.id, sentAt + 2000), { status: 409 });
  // 担当から外れた (権限を失った) 後は本人でも 404
  const other = await postMessage(db, planner(), ids.caseA, 'もう一件');
  await db
    .prepare('UPDATE wedding_cases SET primary_planner_id=? WHERE id=?')
    .bind(ids.plannerA2, ids.caseA)
    .run();
  try {
    await assert.rejects(retractMessage(db, planner(), other.id), { status: 404 });
  } finally {
    await db
      .prepare('UPDATE wedding_cases SET primary_planner_id=? WHERE id=?')
      .bind(ids.plannerA, ids.caseA)
      .run();
  }
});

test('既読は戻らず、未読数は自分の発言・取り消し済み・範囲外を数えない', async () => {
  await clearMessages();
  const t = Date.UTC(2027, 0, 1);
  // 担当者が 3 件、新婦が 1 件、うち担当者の 1 件は取り消し済み
  await insertRaw(ids.caseA, 1, ids.plannerA, iso(t));
  await insertRaw(ids.caseA, 2, ids.plannerA, iso(t + 1000));
  await insertRaw(ids.caseA, 3, ids.plannerA, iso(t + 2000));
  await insertRaw(ids.caseA, 4, ids.coupleA, iso(t + 3000));
  await db
    .prepare('UPDATE case_messages SET body_enc=NULL,deleted_at=? WHERE id=?')
    .bind(iso(t + 4000), uuid(3))
    .run();
  await insertRaw(ids.caseB, 5, ids.plannerB, iso(t));
  const caseIds = [ids.caseA, ids.caseA2, ids.caseB, ids.caseA];

  // 新婦: 担当者の有効な 2 件が未読。caseB は範囲外なので出ない
  assert.deepEqual(await unreadCounts(db, bride(), caseIds), { [ids.caseA]: 2 });
  // 担当者: 新婦の 1 件だけ
  assert.deepEqual(await unreadCounts(db, planner(), [ids.caseA, ids.caseA2]), { [ids.caseA]: 1 });
  // 範囲外の担当者・別式場には出ない
  assert.deepEqual(await unreadCounts(db, actor('planner', ids.plannerA2), [ids.caseA]), {});
  assert.deepEqual(await unreadCounts(db, bride(), []), {});

  await markRead(db, bride(), ids.caseA, encodeCursor(iso(t + 1000), uuid(2)));
  assert.deepEqual(await unreadCounts(db, bride(), [ids.caseA]), { [ids.caseA]: 0 });
  // 古いカーソルで既読位置は戻らない
  await markRead(db, bride(), ids.caseA, encodeCursor(iso(t), uuid(1)));
  const marker = await db
    .prepare('SELECT last_read_at FROM case_message_reads WHERE case_id=? AND user_id=?')
    .bind(ids.caseA, ids.coupleA)
    .first();
  assert.equal(marker.last_read_at, iso(t + 1000));
  // 自分の投稿は既読扱い
  const sent = await postMessage(db, bride(), ids.caseA, '返信');
  assert.deepEqual(await unreadCounts(db, bride(), [ids.caseA]), { [ids.caseA]: 0 });
  assert.deepEqual(await unreadCounts(db, planner(), [ids.caseA]), { [ids.caseA]: 2 });
  assert.ok(sent.id);
});

test('未読数は束縛変数の上限を超える件数でも数えられる', async () => {
  const many = Array.from({ length: 130 }, () => crypto.randomUUID());
  const counts = await unreadCounts(db, planner(), [...many, ids.caseA]);
  assert.deepEqual(Object.keys(counts), [ids.caseA]);
});

test('削除バッチは終了後180日を超えた案件のチャットを消す', async () => {
  await clearMessages();
  await insertRaw(ids.caseA, 1, ids.plannerA, iso(Date.now()));
  await insertRaw(ids.caseA2, 2, ids.plannerA2, iso(Date.now()));
  await markRead(db, planner(), ids.caseA, encodeCursor(iso(Date.now()), uuid(1)));
  await markRead(
    db,
    actor('planner', ids.plannerA2),
    ids.caseA2,
    encodeCursor(iso(Date.now()), uuid(2)),
  );
  await db
    .prepare("UPDATE wedding_cases SET archived_at='2020-01-01T00:00:00.000Z' WHERE id=?")
    .bind(ids.caseA)
    .run();
  try {
    await purgeCasesD1(db, null);
    const count = (sql, id) => db.prepare(sql).bind(id).first('n');
    assert.equal(
      await count('SELECT count(*) AS n FROM case_messages WHERE case_id=?', ids.caseA),
      0,
    );
    assert.equal(
      await count('SELECT count(*) AS n FROM case_message_reads WHERE case_id=?', ids.caseA),
      0,
    );
    // 対象外の案件は残る
    assert.equal(
      await count('SELECT count(*) AS n FROM case_messages WHERE case_id=?', ids.caseA2),
      1,
    );
    assert.equal(
      await count('SELECT count(*) AS n FROM case_message_reads WHERE case_id=?', ids.caseA2),
      1,
    );
  } finally {
    await db.prepare('UPDATE wedding_cases SET archived_at=NULL WHERE id=?').bind(ids.caseA).run();
  }
});
