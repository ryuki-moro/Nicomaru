import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { ids, seedAppFixtures } from '../../scripts/d1-fixtures.mjs';
import { encryptPii, readPii } from '../../src/lib/crypto.ts';
import { patchCase, caseRow } from '../../src/lib/d1/cases.ts';
import {
  taskRow,
  submitTask,
  reviewSubmission,
  submissionRow,
  taskList,
  pendingSubmissions,
  latestSubmission,
} from '../../src/lib/d1/tasks.ts';

let platform, db;
const actor = (id) => ({ id });
const couple = actor(ids.coupleA),
  planner = actor(ids.plannerA);
const task = 'task-caseA';
const answer = (textValue = '回答') => ({ submissionType: 'text', textValue, draft: false });
before(async () => {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of ['0001_auth.sql', '0002_cases.sql', '0003_onboarding.sql', '0004_tasks.sql']) {
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
after(async () => platform?.dispose());

test('一時保存→提出→差し戻し→再提出→確認、暗号化と履歴を保つ', async () => {
  const draft = await submitTask(db, couple, task, { ...answer('下書き'), draft: true });
  assert.equal((await taskRow(db, couple, task)).status, 'not_started');
  await assert.rejects(submissionRow(db, planner, draft.id), { code: 'NOT_FOUND' });
  const first = await submitTask(db, couple, task, answer('最初の回答'));
  assert.equal(first.id, draft.id);
  await assert.rejects(submitTask(db, couple, task, { ...answer(), draft: true }), { status: 422 });
  assert.equal((await pendingSubmissions(db, planner, 0)).count, 1);
  await assert.rejects(reviewSubmission(db, planner, first.id, { decision: 'needs_fix' }), {
    code: 'VALIDATION_ERROR',
  });
  await reviewSubmission(db, planner, first.id, { decision: 'needs_fix', comment: '人数を追記' });
  assert.equal((await taskRow(db, couple, task)).status, 'needs_fix');
  const second = await submitTask(db, couple, task, answer('修正した回答'));
  assert.notEqual(second.id, first.id);
  await assert.rejects(reviewSubmission(db, planner, first.id, { decision: 'confirmed' }), {
    status: 409,
  });
  await reviewSubmission(db, planner, second.id, { decision: 'confirmed' });
  assert.equal((await taskRow(db, couple, task)).status, 'confirmed');
  const stored = await db
    .prepare('SELECT * FROM task_submissions WHERE id=?')
    .bind(second.id)
    .first();
  assert.notEqual(stored.text_value, '修正した回答');
  assert.equal(readPii(stored.text_value), '修正した回答');
  assert.equal((await pendingSubmissions(db, planner, 0)).count, 0);
  assert.equal(
    (
      await db
        .prepare('SELECT COUNT(*) n FROM task_submissions WHERE case_task_id=? AND is_latest=1')
        .bind(task)
        .first()
    ).n,
    1,
  );
});

test('他式場・同式場の別担当・ロール偽装・停止・アーカイブをDB現在値で拒否', async () => {
  for (const id of [ids.plannerB, ids.plannerA2, ids.coupleB]) {
    await assert.rejects(taskRow(db, { id, role: 'system_admin' }, task), { code: 'NOT_FOUND' });
  }
  assert.equal((await taskRow(db, actor(ids.system), task)).id, task);
  assert.equal((await taskRow(db, actor(ids.adminA), task)).id, task);
  await assert.rejects(submitTask(db, planner, task, answer()), { code: 'FORBIDDEN' });
  await assert.rejects(submitTask(db, actor(ids.coupleB), task, answer()), { code: 'NOT_FOUND' });
  assert.equal((await taskList(db, actor(ids.coupleB), ['confirmed'], 0)).length, 0);
  await db
    .prepare("UPDATE user_profiles SET status='suspended' WHERE id=?")
    .bind(ids.coupleA)
    .run();
  await assert.rejects(submitTask(db, couple, task, answer()), { code: 'FORBIDDEN' });
  await db.prepare("UPDATE user_profiles SET status='active' WHERE id=?").bind(ids.coupleA).run();
  await db
    .prepare('UPDATE wedding_cases SET archived_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(ids.caseA)
    .run();
  await assert.rejects(submitTask(db, couple, task, answer()), { code: 'NOT_FOUND' });
  await db.prepare('UPDATE wedding_cases SET archived_at=NULL WHERE id=?').bind(ids.caseA).run();
});

test('同時再提出・同時確認は整合性と最新1件を維持', async () => {
  const results = await Promise.allSettled([
    submitTask(db, couple, task, answer('並行1')),
    submitTask(db, couple, task, answer('並行2')),
  ]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.status, 409);
  const latest = await db
    .prepare('SELECT id FROM task_submissions WHERE case_task_id=? AND is_latest=1')
    .bind(task)
    .first();
  const reviews = await Promise.allSettled([
    reviewSubmission(db, planner, latest.id, { decision: 'confirmed' }),
    reviewSubmission(db, planner, latest.id, { decision: 'needs_fix', comment: '再確認' }),
  ]);
  assert.equal(reviews.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(reviews.find((r) => r.status === 'rejected').reason.status, 409);
  const row = await submissionRow(db, planner, latest.id);
  assert.equal(row.case_tasks.status, row.review_status);
});

test('途中のDB例外では提出・状態・監査をまとめて巻き戻す', async () => {
  const beforeTask = await taskRow(db, couple, task);
  const beforeRows = (await db.prepare('SELECT * FROM task_submissions ORDER BY id').all()).results;
  await db
    .prepare(
      "CREATE TRIGGER fail_task_audit BEFORE INSERT ON case_audit BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    )
    .run();
  try {
    await assert.rejects(submitTask(db, couple, task, answer('ロールバック対象')));
  } finally {
    await db.prepare('DROP TRIGGER fail_task_audit').run();
  }
  assert.deepEqual(await taskRow(db, couple, task), beforeTask);
  assert.deepEqual(
    (await db.prepare('SELECT * FROM task_submissions ORDER BY id').all()).results,
    beforeRows,
  );
});

test('相手の下書きは表示せず、同じ案件の提出として引き継ぎ、スタッフの閲覧も拒否', async () => {
  const partner = randomUUID();
  await db
    .prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,0,0)',
    )
    .bind(partner, '新郎', partner + '@example.test')
    .run();
  await db
    .prepare("INSERT INTO user_profiles(id,venue_id,role,status) VALUES(?,?,'couple','active')")
    .bind(partner, ids.venueA)
    .run();
  await db
    .prepare("UPDATE couple_profiles SET user_id=? WHERE case_id=? AND partner_role='groom'")
    .bind(partner, ids.caseA)
    .run();
  const draft = await submitTask(db, couple, task, { ...answer('本人の下書き'), draft: true });
  assert.equal(await latestSubmission(db, actor(partner), task), null);
  await assert.rejects(submissionRow(db, planner, draft.id), { code: 'NOT_FOUND' });
  const submitted = await submitTask(db, actor(partner), task, answer('新郎から提出'));
  assert.equal(submitted.id, draft.id);
  assert.equal((await latestSubmission(db, couple, task)).submitted_by, partner);
});

test('検証後にアカウント停止・担当変更されても部分書込みせず409にする', async () => {
  const beforeRows = (await db.prepare('SELECT * FROM task_submissions ORDER BY id').all()).results;
  const racing = {
    prepare: db.prepare.bind(db),
    batch: async (statements) => {
      await db
        .prepare("UPDATE user_profiles SET status='suspended' WHERE id=?")
        .bind(ids.coupleA)
        .run();
      return db.batch(statements);
    },
  };
  try {
    await assert.rejects(submitTask(racing, couple, task, answer('失効後の回答')), { status: 409 });
  } finally {
    await db.prepare("UPDATE user_profiles SET status='active' WHERE id=?").bind(ids.coupleA).run();
  }
  assert.deepEqual(
    (await db.prepare('SELECT * FROM task_submissions ORDER BY id').all()).results,
    beforeRows,
  );
});

test('案件の日程変更と提出が競合しても古い期限・状態で上書きしない', async () => {
  const staff = { id: ids.plannerA, role: 'planner', venueId: ids.venueA };
  const before = await caseRow(db, staff, ids.caseA);
  let submitted = false;
  const racing = {
    prepare: db.prepare.bind(db),
    batch: async (statements) => {
      if (!submitted) {
        submitted = true;
        await submitTask(db, couple, task, answer('日程変更との競合'));
      }
      return db.batch(statements);
    },
  };
  await assert.rejects(
    patchCase(racing, staff, ids.caseA, { weddingDate: '2027-07-20', confirmed: true }),
    { status: 409 },
  );
  assert.equal((await caseRow(db, staff, ids.caseA)).wedding_date, before.wedding_date);
  assert.equal((await taskRow(db, couple, task)).status, 'submitted');
});
