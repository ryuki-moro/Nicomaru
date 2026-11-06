import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { ids, seedAppFixtures } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import { requireAiWorkerCall } from '../../src/lib/api/internal.ts';
import {
  aiAssistStatus,
  enqueueJob,
  enqueueTaskJob,
  jobRow,
  latestJobForTask,
  reviewJob,
  workerClaim,
  workerComplete,
  workerPing,
} from '../../src/lib/d1/ai.ts';

let platform, db;
const planner = { id: ids.plannerA },
  otherVenue = { id: ids.plannerB },
  couple = { id: ids.coupleA };
const task = 'task-caseA';
before(async () => {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of [
    '0001_auth.sql',
    '0002_cases.sql',
    '0003_onboarding.sql',
    '0004_tasks.sql',
    '0010_ai.sql',
  ]) {
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

test('心拍が10分以内のときだけ利用可能', async () => {
  assert.equal((await aiAssistStatus(db)).available, false);
  await workerPing(db, 'gpu-1', 'gemma3:12b');
  assert.equal((await aiAssistStatus(db)).available, true);
  await db
    .prepare('UPDATE ai_worker_heartbeats SET last_seen_at=?')
    .bind(new Date(Date.now() - 11 * 60_000).toISOString())
    .run();
  assert.equal((await aiAssistStatus(db)).available, false);
});

test('投入→取得→完了→採用。入力は暗号化し、他式場からは見えない', async () => {
  const id = await enqueueTaskJob(db, couple, task, 'classification', {
    text: '最初の文面',
    params: {},
  });
  // 取得前なら積み増さず、入力を最新の提出に差し替える
  assert.equal(
    await enqueueTaskJob(db, couple, task, 'classification', {
      text: '衣装の相談です',
      params: {},
    }),
    id,
  );
  const stored = await db.prepare('SELECT input_ref FROM ai_jobs WHERE id=?').bind(id).first();
  assert.ok(!stored.input_ref.includes('衣装'));
  await assert.rejects(jobRow(db, otherVenue, id), { status: 404 });
  await assert.rejects(jobRow(db, couple, id), { status: 404 });

  const claimed = await workerClaim(db, 'gpu-1', ['classification']);
  assert.equal(claimed.id, id);
  assert.equal(claimed.input_ref.text, '衣装の相談です');
  assert.match(claimed.prompt_text, /カテゴリ/);
  assert.equal(await workerClaim(db, 'gpu-2', ['classification']), null);
  // 処理中は古い入力で走っているので、再提出は別ジョブにする
  const next = await enqueueTaskJob(db, couple, task, 'classification', {
    text: '再提出',
    params: {},
  });
  assert.notEqual(next, id);
  await db.prepare("UPDATE ai_jobs SET status='discarded' WHERE id=?").bind(next).run();

  // 掴んだワーカー以外は書けない。スキーマ外の出力も保存しない
  assert.equal(
    await workerComplete(db, 'gpu-2', { id, output: { labels: ['衣装'], confidence: 0.9 } }),
    false,
  );
  await assert.rejects(workerComplete(db, 'gpu-1', { id, output: { labels: ['謎'] } }), {
    status: 422,
  });
  assert.equal(
    await workerComplete(db, 'gpu-1', { id, output: { labels: ['衣装'], confidence: 0.9 } }),
    true,
  );

  const done = await latestJobForTask(db, planner, task, 'classification');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.output.labels, ['衣装']);
  await assert.rejects(reviewJob(db, planner, id, 'confirmed', { labels: ['謎'] }), {
    status: 400,
  });
  await reviewJob(db, planner, id, 'confirmed', { labels: ['費用'], confidence: 1 });
  assert.deepEqual((await jobRow(db, planner, id)).reviewed_output.labels, ['費用']);
  await assert.rejects(reviewJob(db, planner, id, 'discarded'), { status: 409 });
});

test('30分応答のないジョブは戻し、3回目で失敗にする', async () => {
  const id = await enqueueJob(db, planner, {
    caseId: ids.caseA,
    jobType: 'draft',
    relatedTaskId: task,
    input: { text: '下書き', params: {} },
  });
  await assert.rejects(
    enqueueJob(db, otherVenue, { caseId: ids.caseA, jobType: 'draft', input: { params: {} } }),
    { status: 404 },
  );
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal((await workerClaim(db, 'gpu-1', ['draft'])).id, id);
    await db.prepare('UPDATE ai_jobs SET locked_at=? WHERE id=?').bind(old, id).run();
  }
  assert.equal(await workerClaim(db, 'gpu-1', ['draft']), null);
  assert.equal((await jobRow(db, planner, id)).status, 'failed');
});

test('ワーカーの共有トークンは一致し32文字以上のときだけ通す', () => {
  const call = (auth) =>
    new Request('http://x/api/internal/ai-worker', {
      headers: auth ? { authorization: auth } : {},
    });
  process.env.AI_WORKER_TOKEN = 'short';
  assert.throws(() => requireAiWorkerCall(call('Bearer short')), { status: 401 });
  process.env.AI_WORKER_TOKEN = 'a'.repeat(32);
  assert.throws(() => requireAiWorkerCall(call()), { status: 401 });
  assert.throws(() => requireAiWorkerCall(call(`Bearer ${'b'.repeat(32)}`)), { status: 401 });
  assert.doesNotThrow(() => requireAiWorkerCall(call(`Bearer ${'a'.repeat(32)}`)));
});
