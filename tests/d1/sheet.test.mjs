import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { ids, seedAppFixtures } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import { jobRow, reviewJob, workerClaim, workerComplete, workerPing } from '../../src/lib/d1/ai.ts';
import { listNotes, saveNote } from '../../src/lib/d1/meeting.ts';
import { recordSheet, requestSheetDraft, sheetData } from '../../src/lib/d1/sheet.ts';
import { addTask } from '../../src/lib/d1/tasks.ts';

let platform, db;
const planner = { id: ids.plannerA, role: 'planner' },
  otherVenue = { id: ids.plannerB, role: 'planner' },
  couple = { id: ids.coupleA, role: 'couple' };

before(async () => {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of [
    '0001_auth.sql',
    '0002_cases.sql',
    '0003_onboarding.sql',
    '0004_tasks.sql',
    '0005_notifications.sql',
    '0010_ai.sql',
    '0014_sheet.sql',
    '0015_meeting.sql',
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

test('AIプロンプト seed に draft と task_extraction がある（0010で投入済み）', async () => {
  const rows = await db
    .prepare(
      'SELECT job_type FROM ai_prompt_templates WHERE active=1 AND venue_id IS NULL ORDER BY job_type',
    )
    .all();
  const types = rows.results.map((r) => r.job_type);
  assert.ok(types.includes('draft'), 'draft prompt');
  assert.ok(types.includes('task_extraction'), 'task_extraction prompt');
});

test('準備シート: 記録の保存と前回記録の取得。他式場・新郎新婦からは見えない', async () => {
  const before1 = await sheetData(db, planner, ids.caseA);
  assert.equal(before1.lastSheet, null);
  assert.equal(before1.target.case_code, 'A-001');
  assert.ok(before1.target.case_tasks.length >= 1);

  const sheetId = await recordSheet(db, planner, ids.caseA, {
    caseCode: 'A-001',
    totalTasks: 1,
  });
  assert.ok(sheetId);
  const after1 = await sheetData(db, planner, ids.caseA);
  assert.equal(after1.lastSheet.id, sheetId);
  assert.deepEqual(JSON.parse(after1.lastSheet.summary_json), { caseCode: 'A-001', totalTasks: 1 });

  await assert.rejects(sheetData(db, otherVenue, ids.caseA));
  await assert.rejects(recordSheet(db, otherVenue, ids.caseA, {}));
  await assert.rejects(recordSheet(db, couple, ids.caseA, {}));
});

test('準備シートAI下書き: 依頼→ワーカー処理→採用でシートに載せられる', async () => {
  await workerPing(db, 'gpu-sheet', 'gemma3:12b');
  const jobId = await requestSheetDraft(db, planner, ids.caseA);
  assert.ok(jobId);
  const claimed = await workerClaim(db, 'gpu-sheet', ['draft']);
  assert.equal(claimed.id, jobId);
  assert.match(claimed.input_ref.text, /未提出の宿題/);
  assert.match(claimed.prompt_text, /下書き/);
  assert.equal(
    await workerComplete(db, 'gpu-sheet', {
      id: jobId,
      output: { text: '出席者の確認が未提出です。次回までにご確認ください。', cautions: [] },
    }),
    true,
  );
  const job = await jobRow(db, planner, jobId);
  assert.equal(job.status, 'done');
  assert.match(job.output.text, /出席者の確認/);
  await reviewJob(db, planner, jobId, 'confirmed');
  assert.equal((await jobRow(db, planner, jobId)).status, 'confirmed');
  // 採用済みジョブをシート記録へ紐づけられる
  const sheetId = await recordSheet(db, planner, ids.caseA, { caseCode: 'A-001' }, jobId);
  const { lastSheet } = await sheetData(db, planner, ids.caseA);
  assert.equal(lastSheet.id, sheetId);
  assert.equal(lastSheet.ai_draft_job_id, jobId);
});

test('打ち合わせ記録: 保存で起票ジョブが投入され、案→宿題登録まで通る', async () => {
  const { id: noteId, jobId } = await saveNote(db, planner, {
    caseId: ids.caseA,
    body: 'BGMは新婦が候補を出す。引き出物はカタログAで最終確定する。',
    meetingDate: '2026-11-07',
    participants: '新郎新婦、担当プランナー',
  });
  assert.ok(noteId);
  assert.ok(jobId, 'task_extraction ジョブが投入される');

  const notes = await listNotes(db, planner, ids.caseA);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /BGM/);
  assert.equal(notes[0].meeting_date, '2026-11-07');
  await assert.rejects(listNotes(db, couple, ids.caseA));
  await assert.rejects(saveNote(db, couple, { caseId: ids.caseA, body: 'x' }));

  const claimed = await workerClaim(db, 'gpu-sheet', ['task_extraction']);
  assert.equal(claimed.id, jobId);
  assert.equal(claimed.input_ref.ref.table, 'meeting_notes');
  assert.equal(claimed.input_ref.ref.id, noteId);
  assert.equal(
    await workerComplete(db, 'gpu-sheet', {
      id: jobId,
      output: {
        tasks: [
          { title: 'BGM候補を出す', description: 'メモより', due_hint: '次回の打ち合わせまで' },
        ],
      },
    }),
    true,
  );
  const job = await jobRow(db, planner, jobId);
  assert.equal(job.output.tasks[0].title, 'BGM候補を出す');

  // 起票案の登録は既存の宿題追加（D1 tasks）を使う
  const created = await addTask(db, planner, ids.caseA, {
    title: job.output.tasks[0].title,
    description: job.output.tasks[0].description,
    submissionFormat: 'text',
    allowedFileTypes: [],
    options: {},
    importance: 'normal',
    isRequired: true,
    dueDate: '2027-05-01',
  });
  assert.ok(created.id);
  const row = await db.prepare('SELECT title FROM case_tasks WHERE id=?').bind(created.id).first();
  assert.equal(row.title, 'BGM候補を出す');
});
