import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import { reclaimStalledAiJobs } from '../../src/lib/d1/ai.ts';
import {
  createVenueD1,
  getPlanTypeD1,
  getTemplateD1,
  listPlanTypesD1,
  listTemplatesD1,
  listVenuesAdmin,
  savePlanTypeD1,
  saveTemplateD1,
  systemSummaryD1,
  updateVenueD1,
} from '../../src/lib/d1/admin.ts';
import { purgeCasesD1 } from '../../src/lib/d1/case-purge.ts';
import { collectUsageD1, monitorSystemD1 } from '../../src/lib/d1/monitoring.ts';
import { dispatchNotificationsD1 } from '../../src/lib/d1/notifications-dispatch.ts';
import { todayInJst } from '../../src/lib/format.ts';

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
const system = () => actor('system_admin', ids.system, null);
const adminA = () => actor('admin', ids.adminA);
const plannerA = () => actor('planner', ids.plannerA);

const MIGRATIONS = [
  '0001_auth.sql',
  '0002_cases.sql',
  '0003_onboarding.sql',
  '0004_tasks.sql',
  '0005_notifications.sql',
  '0006_staff.sql',
  '0007_staff_version.sql',
  '0008_guests.sql',
  '0009_guest_review.sql',
  '0010_ai.sql',
  '0011_batch.sql',
  '0013_notifications_extra.sql',
  '0020_usage.sql',
  '0021_admin.sql',
];

before(async () => {
  process.env.NICOMARU_DB = 'd1-local';
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of MIGRATIONS) {
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

test('usage-rollup: スナップショットが当日1行に集計される', async () => {
  const out = await collectUsageD1(db);
  assert.equal(out.targetCount, 1);
  const snap = await db.prepare('SELECT * FROM usage_snapshots').first();
  assert.equal(snap.venue_count, 2);
  assert.equal(snap.case_count, 3);
  assert.ok(snap.user_count >= 8);
  await collectUsageD1(db);
  const count = await db.prepare('SELECT count(*) AS n FROM usage_snapshots').first();
  assert.equal(count.n, 1);
});

test('monitoring: 失敗バッチとAI失敗を検知し、解消で resolved になる', async () => {
  await db
    .prepare(
      "INSERT INTO batch_runs(id,job_type,started_at,finished_at,target_count,http_status) VALUES ('run-fail','risk_recalculate',?,?,0,500)",
    )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();
  await db
    .prepare(
      "INSERT INTO ai_jobs(id,venue_id,case_id,job_type,input_ref,status,created_at,updated_at) VALUES ('ai-fail',?,?,'classification','x','failed',?,?)",
    )
    .bind(ids.venueA, ids.caseA, new Date().toISOString(), new Date().toISOString())
    .run();
  const out = await monitorSystemD1(db);
  assert.ok(out.targetCount >= 2);
  const keys = (
    await db.prepare('SELECT alert_key FROM system_alerts WHERE resolved_at IS NULL').all()
  ).results.map((r) => r.alert_key);
  assert.ok(keys.includes('batch_failed:risk_recalculate'));
  assert.ok(keys.includes('ai_failed'));
  // 解消: 失敗ジョブを成功にし、AI失敗を消す
  await db.prepare("UPDATE batch_runs SET http_status=200 WHERE id='run-fail'").run();
  await db.prepare("DELETE FROM ai_jobs WHERE id='ai-fail'").run();
  await monitorSystemD1(db);
  const resolved = await db
    .prepare("SELECT resolved_at FROM system_alerts WHERE alert_key='ai_failed'")
    .first();
  assert.ok(resolved.resolved_at);
});

test('ai-job-reclaim: 30分滞留は戻し、3回目で failed', async () => {
  const stale = new Date(Date.now() - 31 * 60_000).toISOString();
  for (const [id, attempts] of [
    ['ai-stale-1', 1],
    ['ai-stale-3', 3],
  ]) {
    await db
      .prepare(
        "INSERT INTO ai_jobs(id,venue_id,case_id,job_type,input_ref,status,attempts,locked_by,locked_at,created_at,updated_at) VALUES (?, ?, ?, 'draft', 'x', 'processing', ?, 'gpu-1', ?, ?, ?)",
      )
      .bind(id, ids.venueA, ids.caseA, attempts, stale, stale, stale)
      .run();
  }
  const { requeued, failed } = await reclaimStalledAiJobs(db);
  assert.equal(requeued, 1);
  assert.equal(failed, 1);
  const one = await db.prepare("SELECT status FROM ai_jobs WHERE id='ai-stale-1'").first();
  const three = await db.prepare("SELECT status FROM ai_jobs WHERE id='ai-stale-3'").first();
  assert.equal(one.status, 'queued');
  assert.equal(three.status, 'failed');
});

test('notifications-dispatch: 期限N日前の未提出に in_app 通知を作り二重作成しない', async () => {
  // 既定の通知設定は「7日前」。caseA の bride (coupleA) が宛先
  const due = new Date(`${todayInJst()}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 7);
  const dueDate = due.toISOString().slice(0, 10);
  await db
    .prepare(
      "INSERT INTO case_tasks(id,case_id,title,due_date,status,importance) VALUES ('task-soon', ?, 'もうすぐ期限の宿題', ?, 'not_started', 'normal')",
    )
    .bind(ids.caseA, dueDate)
    .run();
  const first = await dispatchNotificationsD1(db);
  assert.ok(first.created >= 1);
  assert.ok(first.sent >= 1);
  const rows = await db
    .prepare(
      "SELECT status,channel FROM notifications WHERE case_id=? AND notification_type='due_reminder'",
    )
    .bind(ids.caseA)
    .all();
  assert.ok(rows.results.length >= 1);
  assert.ok(rows.results.every((r) => r.status === 'sent' && r.channel === 'in_app'));
  const second = await dispatchNotificationsD1(db);
  assert.equal(second.created, 0);
});

test('case-purge: 180日超のアーカイブ案件の個人情報とファイルを消し、AI保持も効く', async () => {
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  await db
    .prepare(
      "INSERT INTO wedding_cases(id,venue_id,primary_planner_id,plan_type_id,case_code,wedding_date,archived_at) VALUES ('case-old', ?, ?, ?, 'OLD-001', '2025-01-01', ?)",
    )
    .bind(ids.venueA, ids.plannerA, ids.planA, old)
    .run();
  await db
    .prepare('INSERT INTO couple_profiles VALUES (?,?,?,?,?,?)')
    .bind(
      'case-old',
      'bride',
      ids.coupleA,
      encryptPii('旧 太郎'),
      encryptPii('old@example.test'),
      1,
    )
    .run()
    .catch(() => {});
  // coupleA は caseA で既に使われているため、旧案件用に別カップル行は user_id NULL で入れる
  await db
    .prepare(
      "INSERT INTO case_tasks(id,case_id,title,due_date,status,importance) VALUES ('task-old','case-old','旧宿題','2025-01-01','not_started','normal')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO storage_files(id,case_id,task_id,uploaded_by,object_path,original_filename,mime_type,file_size_bytes) VALUES ('file-old','case-old','task-old',?,'file-old','old.csv','text/csv',123)",
    )
    .bind(ids.plannerA)
    .run();
  const deleted = [];
  const fakeBucket = {
    delete: async (key) => {
      deleted.push(key);
    },
    get: async () => null,
    put: async () => {},
  };
  const out = await purgeCasesD1(db, fakeBucket);
  assert.equal(out.targetCount, 1);
  assert.deepEqual(deleted, ['file-old']);
  const file = await db.prepare("SELECT id FROM storage_files WHERE id='file-old'").first();
  assert.equal(file, null);
  const profile = await db
    .prepare("SELECT full_name,email FROM couple_profiles WHERE case_id='case-old'")
    .first();
  if (profile) assert.equal(profile.email, null);
  // 案件行そのものは残る
  const kept = await db.prepare("SELECT id FROM wedding_cases WHERE id='case-old'").first();
  assert.ok(kept);
});

test('venues CRUD: system_admin のみ作成・編集でき、コード重複は 409', async () => {
  await assert.rejects(createVenueD1(db, adminA(), { name: 'x', code: 'NEWV1', active: true }), {
    status: 403,
  });
  const { id } = await createVenueD1(db, system(), {
    name: '検証式場C',
    code: 'VENUEC',
    contactEmail: 'c@example.test',
    active: true,
  });
  await assert.rejects(createVenueD1(db, system(), { name: 'dup', code: 'VENUEC', active: true }), {
    status: 409,
  });
  const updated = await updateVenueD1(db, system(), id, { name: '検証式場C改', active: false });
  assert.equal(updated.name, '検証式場C改');
  assert.equal(updated.active, false);
  const { rows } = await listVenuesAdmin(db, system(), 1);
  assert.ok(rows.some((v) => v.id === id));
});

test('templates/plans CRUD: 保存が templates_json へ同期され、利用状態で割当から外れる', async () => {
  const t1 = await saveTemplateD1(db, adminA(), 'new', {
    name: '招待状の確認',
    description: null,
    submissionFormat: 'text',
    allowedFileTypes: [],
    defaultOptions: {},
    dueOffsetDays: 45,
    importance: 'high',
    isRequired: true,
    active: true,
  });
  assert.ok(t1.id);
  const got = await getTemplateD1(db, adminA(), t1.id);
  assert.equal(got.name, '招待状の確認');
  // 他式場からは見えない
  await assert.rejects(
    saveTemplateD1(db, actor('admin', ids.adminB, ids.venueB), t1.id, {
      name: '乗っ取り',
      submissionFormat: 'text',
      allowedFileTypes: [],
      defaultOptions: {},
      dueOffsetDays: 1,
      importance: 'normal',
      isRequired: true,
      active: true,
    }),
    { status: 404 },
  );
  const plan = await savePlanTypeD1(db, adminA(), 'new', {
    name: '検証プラン',
    description: null,
    defaultGuestCountMin: 10,
    defaultGuestCountMax: 80,
    displayOrder: 9,
    active: true,
    assignments: [{ taskTemplateId: t1.id, displayOrder: 0, dueOffsetDaysOverride: null }],
  });
  const planRow = await db
    .prepare('SELECT templates_json FROM plan_types WHERE id=?')
    .bind(plan.id)
    .first();
  const templates = JSON.parse(planRow.templates_json);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].title, '招待状の確認');
  assert.equal(templates[0].dueOffsetDays, 45);
  // テンプレートを停止すると割当 (templates_json) から外れる
  await saveTemplateD1(db, adminA(), t1.id, {
    name: '招待状の確認',
    description: null,
    submissionFormat: 'text',
    allowedFileTypes: [],
    defaultOptions: {},
    dueOffsetDays: 45,
    importance: 'high',
    isRequired: true,
    active: false,
  });
  const after = await db
    .prepare('SELECT templates_json FROM plan_types WHERE id=?')
    .bind(plan.id)
    .first();
  assert.equal(JSON.parse(after.templates_json).length, 0);
  const { rows: listed } = await listTemplatesD1(db, adminA(), 1);
  assert.ok(listed.some((r) => r.id === t1.id && r.active === false));
  const { rows: plans } = await listPlanTypesD1(db, adminA(), 1);
  assert.ok(plans.some((r) => r.id === plan.id));
  const detail = await getPlanTypeD1(db, adminA(), plan.id);
  assert.equal(detail.assignments.length, 1);
  // planner は管理できない
  await assert.rejects(
    saveTemplateD1(db, plannerA(), 'new', {
      name: 'x',
      submissionFormat: 'text',
      allowedFileTypes: [],
      defaultOptions: {},
      dueOffsetDays: 1,
      importance: 'normal',
      isRequired: true,
      active: true,
    }),
    { status: 403 },
  );
});

test('system summary: 件数と監視・集計が D1 から返る', async () => {
  const s = await systemSummaryD1(db, system());
  assert.ok(s.venueCount >= 3);
  assert.ok(s.caseCount >= 4);
  assert.ok(Array.isArray(s.batches));
  assert.ok(s.usage);
  assert.ok(Array.isArray(s.alerts));
  await assert.rejects(systemSummaryD1(db, adminA()), { status: 403 });
});
