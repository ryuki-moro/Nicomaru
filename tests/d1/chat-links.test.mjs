import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { encryptPii } from '../../src/lib/crypto.ts';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { createTaskFromMessage } from '../../src/lib/d1/message-tasks.ts';
import { addTask } from '../../src/lib/d1/tasks.ts';
import { postSystemMessage } from '../../src/lib/d1/system-messages.ts';
import { listRefCandidates } from '../../src/lib/d1/chat-refs.ts';
import { purgeCasesD1 } from '../../src/lib/d1/case-purge.ts';
import {
  listMessages,
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
const taskA = 'task-caseA';
const guestA = '30000000-0000-4000-8000-0000000000a1';
const legacyId = '20000000-0000-4000-8000-0000000000f1';

async function applyMigration(file) {
  const sql = await readFile(`cloudflare/migrations/${file}`, 'utf8');
  await db.batch(
    sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
}
const insertGuest = () =>
  db
    .prepare(
      `INSERT INTO case_guests(id,case_id,full_name,invitation_status,response_group_id,is_companion,responded_at,created_at)
      VALUES (?,?,?,'reply_yes',?,0,'2026-11-01','2026-11-01')`,
    )
    .bind(guestA, ids.caseA, encryptPii('山田 太郎'), guestA)
    .run();

before(async () => {
  process.env.NICOMARU_DB = 'd1-local';
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  const files = (await readdir('cloudflare/migrations')).filter((f) => f.endsWith('.sql')).sort();
  // 0029 の前の状態でメッセージを入れ、作り直しで残ることを確かめる
  for (const file of files.filter((f) => f < '0029')) await applyMigration(file);
  await seedAppFixtures(db, encryptPii);
  await db
    .prepare(
      'INSERT INTO case_messages(id,case_id,sender_user_id,body_enc,created_at) VALUES (?,?,?,?,?)',
    )
    .bind(legacyId, ids.caseA, ids.plannerA, encryptPii('移行前の発言'), '2026-11-01T00:00:00.000Z')
    .run();
  for (const file of files.filter((f) => f >= '0029')) await applyMigration(file);
  await insertGuest();
});
after(async () => {
  await platform?.dispose();
});

const refsOf = async (messageId) =>
  (await db.prepare('SELECT * FROM case_message_refs WHERE message_id=?').bind(messageId).all())
    .results;
const list = async (user) => (await listMessages(db, user, ids.caseA, { limit: 50 })).items;

test('0029 の作り直しのあとも、既存のメッセージが残り user として読める', async () => {
  const legacy = (await list(bride())).find((m) => m.id === legacyId);
  assert.equal(legacy.body, '移行前の発言');
  assert.equal(legacy.kind, 'user');
  assert.equal(legacy.eventType, null);
  assert.deepEqual(legacy.refs, []);
  assert.deepEqual(legacy.linkedTaskIds, []);
});

test('添付は閲覧者の権限で解決し、新郎新婦とスタッフで移動先が違う', async () => {
  const sent = await postMessage(db, planner(), ids.caseA, '確認してください', [
    { type: 'task', id: taskA },
    { type: 'guest', id: guestA },
    { type: 'seating', id: ids.caseA },
  ]);
  assert.deepEqual(
    sent.refs.map((r) => [r.type, r.title, r.href]),
    [
      ['task', '出席者の確認', `/cases/${ids.caseA}#tasks`],
      ['guest', '山田 太郎', `/cases/${ids.caseA}#guests`],
      ['seating', '席次表', `/cases/${ids.caseA}#seating`],
    ],
  );
  const raw = await refsOf(sent.id);
  assert.equal(raw.length, 3);
  assert.ok(
    raw.every((r) => !('title' in r)),
    '題名は保存しない',
  );
  const seen = (await list(bride())).find((m) => m.id === sent.id);
  assert.deepEqual(
    seen.refs.map((r) => r.href),
    [`/mypage/tasks/${taskA}`, '/mypage/guests', '/mypage/seating'],
  );
  assert.equal(seen.refs[0].status, 'not_started');
});

test('範囲外・存在しない・別案件の添付は 404 で、メッセージも残らない', async () => {
  const count = (await list(planner())).length;
  for (const ref of [
    { type: 'task', id: 'task-caseB' },
    { type: 'task', id: 'no-such-task' },
    { type: 'guest', id: crypto.randomUUID() },
    { type: 'seating', id: ids.caseB },
  ])
    await assert.rejects(postMessage(db, planner(), ids.caseA, '添付', [ref]), { status: 404 });
  assert.equal((await list(planner())).length, count);
});

test('参照だけの投稿ができ、4件目と空の投稿は 400', async () => {
  const only = await postMessage(db, bride(), ids.caseA, '', [{ type: 'task', id: taskA }]);
  assert.equal(only.body, '');
  assert.equal(only.refs.length, 1);
  await assert.rejects(postMessage(db, bride(), ids.caseA, '', []), { status: 400 });
  const four = [
    { type: 'task', id: taskA },
    { type: 'guest', id: guestA },
    { type: 'seating', id: ids.caseA },
    { type: 'task', id: 'x' },
  ];
  await assert.rejects(postMessage(db, bride(), ids.caseA, 'a', four), { status: 400 });
  // 同じ参照は1件にまとめる
  const dup = await postMessage(db, bride(), ids.caseA, 'a', [
    { type: 'task', id: taskA },
    { type: 'task', id: taskA },
  ]);
  assert.equal(dup.refs.length, 1);
});

test('消えた・権限を失った参照は title が null で、題名を漏らさない', async () => {
  const sent = await postMessage(db, planner(), ids.caseA, '消える', [
    { type: 'guest', id: guestA },
  ]);
  await db.prepare('DELETE FROM case_guests WHERE id=?').bind(guestA).run();
  try {
    const view = (await list(bride())).find((m) => m.id === sent.id);
    assert.deepEqual(view.refs, [
      { type: 'guest', id: guestA, title: null, href: null, status: null },
    ]);
  } finally {
    await insertGuest();
  }
  // 参照が別案件のものにすり替わっていても、閲覧者の範囲で引き直すので出ない
  const swapped = await postMessage(db, planner(), ids.caseA, 'x', [{ type: 'task', id: taskA }]);
  await db
    .prepare('UPDATE case_message_refs SET ref_id=? WHERE message_id=?')
    .bind('task-caseB', swapped.id)
    .run();
  const view = (await list(bride())).find((m) => m.id === swapped.id);
  assert.equal(view.refs[0].title, null);
});

test('システムメッセージ（発言者なし）は未読に数え、取り消せない', async () => {
  const sysId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO case_messages(id,case_id,kind,event_type,actor_user_id,created_at) VALUES (?,?,'system','task_submitted',?,?)`,
    )
    .bind(sysId, ids.caseA, ids.coupleA, new Date().toISOString())
    .run();
  await db
    .prepare('INSERT INTO case_message_refs(message_id,position,ref_type,ref_id) VALUES (?,0,?,?)')
    .bind(sysId, 'task', taskA)
    .run();
  const unread = async (u) => (await unreadCounts(db, u, [ids.caseA]))[ids.caseA];
  const sys = (await list(planner())).find((m) => m.id === sysId);
  assert.equal(sys.kind, 'system');
  assert.equal(sys.senderUserId, null);
  assert.equal(sys.mine, false);
  assert.equal(sys.body, 'coupleAさんが『出席者の確認』を提出しました');
  await assert.rejects(retractMessage(db, admin(), sysId), { status: 404 });
  await assert.rejects(retractMessage(db, bride(), sysId), { status: 404 });
  // 操作した新婦の分は数えず、スタッフには数える。発言者なしのバッチ起点は両方に数える
  const brideBefore = await unread(bride());
  const plannerBefore = await unread(planner());
  await db
    .prepare(
      `INSERT INTO case_messages(id,case_id,kind,event_type,created_at) VALUES (?,?,'system','task_overdue',?)`,
    )
    .bind(crypto.randomUUID(), ids.caseA, new Date().toISOString())
    .run();
  assert.equal(await unread(bride()), brideBefore + 1);
  assert.equal(await unread(planner()), plannerBefore + 1);
  await db
    .prepare(
      `INSERT INTO case_messages(id,case_id,kind,event_type,actor_user_id,created_at) VALUES (?,?,'system','task_submitted',?,?)`,
    )
    .bind(crypto.randomUUID(), ids.caseA, ids.coupleA, new Date().toISOString())
    .run();
  assert.equal(await unread(bride()), brideBefore + 1);
  assert.equal(await unread(planner()), plannerBefore + 2);
});

test('添付の候補は閲覧者の範囲だけで、検索語で絞れる', async () => {
  const tasks = await listRefCandidates(db, planner(), ids.caseA, 'task', '');
  assert.ok(tasks.some((t) => t.id === taskA && t.title === '出席者の確認'));
  assert.ok(!tasks.some((t) => t.id === 'task-caseB'));
  assert.deepEqual(await listRefCandidates(db, bride(), ids.caseA, 'task', '存在しない語'), []);
  const guests = await listRefCandidates(db, bride(), ids.caseA, 'guest', '山田');
  assert.deepEqual(
    guests.map((g) => [g.id, g.title]),
    [[guestA, '山田 太郎']],
  );
  assert.deepEqual(
    (await listRefCandidates(db, planner(), ids.caseA, 'seating', '')).map((c) => c.id),
    [ids.caseA],
  );
  // 別案件の担当者・別式場の新郎新婦は 404
  for (const u of [actor('planner', ids.plannerA2), actor('couple', ids.coupleB, ids.venueB)])
    await assert.rejects(listRefCandidates(db, u, ids.caseA, 'task', ''), { status: 404 });
});

const taskInput = (title) => ({
  title,
  submissionFormat: 'text',
  allowedFileTypes: [],
  options: {},
  importance: 'normal',
  isRequired: true,
  dueDate: '2027-05-20',
});

test('スタッフはメッセージからやることを作れ、元メッセージにひも付いてシステムメッセージが流れる', async () => {
  const source = await postMessage(db, bride(), ids.caseA, '招待状の宛名を確認したいです');
  const created = await createTaskFromMessage(db, planner(), source.id, taskInput('宛名の確認'));
  const row = await db
    .prepare('SELECT source_message_id,case_id FROM case_tasks WHERE id=?')
    .bind(created.id)
    .first();
  assert.equal(row.source_message_id, source.id);
  assert.equal(row.case_id, ids.caseA);
  const items = await list(bride());
  assert.deepEqual(items.find((m) => m.id === source.id).linkedTaskIds, [created.id]);
  const system = items.find((m) => m.eventType === 'task_created');
  assert.equal(system.body, 'plannerAさんが『宛名の確認』を作成しました');
  assert.equal(system.refs[0].href, `/mypage/tasks/${created.id}`);
  // 新郎新婦のやること一覧に出る
  const candidates = await listRefCandidates(db, bride(), ids.caseA, 'task', '宛名');
  assert.deepEqual(
    candidates.map((c) => c.id),
    [created.id],
  );
});

test('やること化できるのは担当のスタッフだけで、取り消し済み・システムメッセージは 409', async () => {
  const source = await postMessage(db, planner(), ids.caseA, '作れない確認');
  for (const u of [
    bride(),
    actor('planner', ids.plannerA2),
    actor('admin', ids.adminB, ids.venueB),
  ])
    await assert.rejects(createTaskFromMessage(db, u, source.id, taskInput('x')), { status: 404 });
  await assert.rejects(createTaskFromMessage(db, planner(), crypto.randomUUID(), taskInput('x')), {
    status: 404,
  });
  const system = (await list(planner())).find((m) => m.kind === 'system');
  await assert.rejects(createTaskFromMessage(db, planner(), system.id, taskInput('x')), {
    status: 409,
  });
  await retractMessage(db, planner(), source.id);
  await assert.rejects(createTaskFromMessage(db, planner(), source.id, taskInput('x')), {
    status: 409,
  });
  // 確認のあとに取り消された元メッセージでは、INSERT 自体が通らない
  await assert.rejects(addTask(db, planner(), ids.caseA, taskInput('x'), source.id), {
    status: 404,
  });
  const count = await db.prepare("SELECT count(*) AS n FROM case_tasks WHERE title='x'").first();
  assert.equal(count.n, 0);
});

test('取り消すと添付も外れ、案件の削除バッチで参照も消える', async () => {
  const sent = await postMessage(db, planner(), ids.caseA, '取り消す', [
    { type: 'task', id: taskA },
  ]);
  await retractMessage(db, planner(), sent.id);
  assert.equal((await refsOf(sent.id)).length, 0);
  const kept = await postMessage(db, planner(), ids.caseA, '残る', [{ type: 'task', id: taskA }]);
  await db
    .prepare("UPDATE wedding_cases SET archived_at='2020-01-01T00:00:00.000Z' WHERE id=?")
    .bind(ids.caseA)
    .run();
  await purgeCasesD1(db, null);
  assert.equal((await refsOf(kept.id)).length, 0);
  const left = await db
    .prepare('SELECT count(*) AS n FROM case_messages WHERE case_id=?')
    .bind(ids.caseA)
    .first();
  assert.equal(left.n, 0);
});

test('同じ重複キーのシステムメッセージは、同時に流しても1件だけ', async () => {
  const send = async () => {};
  const key = `due_soon:${taskA}:2026-11-27`;
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      postSystemMessage(db, ids.caseA, 'task_due_soon', [{ type: 'task', id: taskA }], null, {
        dedupeKey: key,
        send,
      }),
    ),
  );
  assert.deepEqual(results.filter(Boolean).length, 1);
  const rows = await db.prepare('SELECT id FROM case_messages WHERE dedupe_key=?').bind(key).all();
  assert.equal(rows.results.length, 1);
  assert.equal((await refsOf(rows.results[0].id)).length, 1);
});
