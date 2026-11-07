import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { ids, seedAppFixtures } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import { translateWithDictionary } from '../../src/lib/ai/translation-fallback.ts';
import { buildTemplateDraft } from '../../src/lib/ai/template-draft.ts';
import {
  enqueueHandover,
  enqueueReschedule,
  enqueueTemplateDraft,
  enqueueTranslation,
  latestExtJob,
  prepareHandover,
  prepareReschedule,
  prepareTemplateDraft,
} from '../../src/lib/d1/ai-ext.ts';
import { workerClaim, workerComplete, workerPing } from '../../src/lib/d1/ai.ts';

let platform, db;
const planner = { id: ids.plannerA, role: 'planner' };
const otherVenue = { id: ids.plannerB, role: 'planner' };

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
    '0023_ai_ext.sql',
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
  await workerPing(db, 'gpu-ext', 'gemma3:12b');
});

after(async () => platform?.dispose());

/** 投入→claim→complete をモックワーカーとして1周し、表示用に最新ジョブを取り直す */
async function runJob(jobType, output) {
  const claimed = await workerClaim(db, 'gpu-ext', [jobType]);
  assert.ok(claimed, `${jobType} のジョブが claim できること`);
  assert.equal(claimed.job_type, jobType);
  assert.ok(claimed.prompt_text, `${jobType} のプロンプト seed があること`);
  assert.equal(await workerComplete(db, 'gpu-ext', { id: claimed.id, output }), true);
  return claimed;
}

test('0022: 拡張4種のプロンプト seed が入っている (faq_answer は入れない)', async () => {
  const rows = await db
    .prepare(
      "SELECT job_type FROM ai_prompt_templates WHERE id LIKE '00000000-0000-4000-a000-00000000000%' ORDER BY job_type",
    )
    .all();
  const types = rows.results.map((r) => r.job_type);
  for (const t of ['translation', 'template_draft', 'handover_summary', 'reschedule_plan'])
    assert.ok(types.includes(t), t);
  // seed は 0010 の4種 + 0022 の4種 = 8種。faq_answer の seed は無い
  const faq = await db
    .prepare("SELECT COUNT(*) AS n FROM ai_prompt_templates WHERE job_type='faq_answer'")
    .first();
  assert.equal(faq.n, 0);
});

test('① translation: 辞書フォールバック (ワーカー不要)', () => {
  const hit = translateWithDictionary(
    'お世話になっております。ご提出いただきありがとうございます。',
    'en',
  );
  assert.equal(hit.matched, 2);
  assert.match(hit.output.text, /Thank you/);
  assert.equal(hit.output.language, 'en');
  const miss = translateWithDictionary('全く辞書に無い文です。', 'en');
  assert.equal(miss.matched, 0);
  assert.ok(miss.output.cautions.some((c) => c.includes('原文のまま')));
});

test('① translation: ジョブ投入→完了→表示データ取得', async () => {
  const id = await enqueueTranslation(db, planner, {
    caseId: ids.caseA,
    relatedTaskId: 'task-caseA',
    text: 'ご提出いただきありがとうございます。',
    language: 'en',
  });
  assert.ok(id);
  await assert.rejects(
    enqueueTranslation(db, otherVenue, { caseId: ids.caseA, text: 'x', language: 'en' }),
    { status: 404 },
  );
  const claimed = await runJob('translation', {
    text: 'Thank you for your submission.',
    language: 'en',
    cautions: [],
  });
  assert.equal(claimed.id, id);
  const shown = await latestExtJob(db, planner, ids.caseA, 'translation');
  assert.equal(shown.status, 'done');
  assert.equal(shown.output.text, 'Thank you for your submission.');
  // スキーマ外の出力は保存できない
  const bad = await enqueueTranslation(db, planner, {
    caseId: ids.caseA,
    text: '再度',
    language: 'en',
  });
  const claimed2 = await workerClaim(db, 'gpu-ext', ['translation']);
  assert.equal(claimed2.id, bad);
  await assert.rejects(workerComplete(db, 'gpu-ext', { id: bad, output: { text: 123 } }), {
    status: 422,
  });
});

test('② template_draft: ルール生成 + ジョブ投入→完了→表示', async () => {
  const rule = buildTemplateDraft({
    existing: [{ name: '招待客リスト', due_offset_days: 90 }],
    daysUntilWedding: 50,
  });
  // 挙式まで50日なら 90/60 日前項目は出ず、45日以内の項目だけが残る
  assert.ok(rule.templates.every((t) => t.due_offset_days <= 50));
  assert.ok(rule.templates.length >= 3);

  const prepared = await prepareTemplateDraft(db, planner, ids.caseA);
  assert.ok(prepared.draft.templates.length >= 1);
  const { id } = await enqueueTemplateDraft(db, planner, ids.caseA);
  const claimed = await runJob('template_draft', prepared.draft);
  assert.equal(claimed.id, id);
  const shown = await latestExtJob(db, planner, ids.caseA, 'template_draft');
  assert.equal(shown.status, 'done');
  assert.deepEqual(shown.output, prepared.draft);
});

test('③ handover_summary: 集約フォールバック + ジョブ投入→完了→表示', async () => {
  const prepared = await prepareHandover(db, planner, ids.caseA);
  assert.equal(prepared.aggregate.total, 1);
  assert.match(prepared.fallback.summary, /A-001/);
  const { id, fallback } = await enqueueHandover(db, planner, ids.caseA);
  assert.equal(fallback.summary, prepared.fallback.summary);
  const claimed = await runJob('handover_summary', prepared.fallback);
  assert.equal(claimed.id, id);
  const shown = await latestExtJob(db, planner, ids.caseA, 'handover_summary');
  assert.equal(shown.status, 'done');
  assert.match(shown.output.summary, /A-001/);
});

test('④ reschedule_plan: 日付はルール計算のみ + ジョブは説明文だけ', async () => {
  // fixtures の宿題は期限 2027-05-21 (過去ではない) ため、後ろ倒し指定で案を作る
  const plan = await prepareReschedule(db, planner, ids.caseA, 7);
  assert.equal(plan.shifts.length, 1);
  assert.equal(plan.shifts[0].from, '2027-05-21');
  assert.equal(plan.shifts[0].to, '2027-05-28');
  assert.ok(plan.shifts[0].to < '2027-06-20', '挙式日を超えない');
  const { id } = await enqueueReschedule(db, planner, ids.caseA, 7);
  const claimed = await runJob('reschedule_plan', plan.output);
  assert.equal(claimed.id, id);
  const shown = await latestExtJob(db, planner, ids.caseA, 'reschedule_plan');
  assert.equal(shown.status, 'done');
  assert.match(shown.output.explanation, /2027-05-28/);
});
