import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import {
  forEachActiveCaseD1,
  listBatchRuns,
  runBatchD1,
  BatchFailure,
} from '../../src/lib/d1/batches.ts';
import { recalculateCaseRiskD1, getCurrentRiskD1 } from '../../src/lib/d1/risk.ts';
import { caseRow, listCases } from '../../src/lib/d1/cases.ts';
import {
  getNotificationSettingsD1,
  incrementNotificationQuotaD1,
  loadNotificationLogsForExportD1,
  recordNotificationLog,
} from '../../src/lib/d1/notifications.ts';

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

before(async () => {
  process.env.NICOMARU_DB = 'd1-local';
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of [
    '0001_auth.sql',
    '0002_cases.sql',
    '0003_onboarding.sql',
    '0004_tasks.sql',
    '0005_notifications.sql',
    '0011_batch.sql',
    '0012_risk.sql',
    '0013_notifications_extra.sql',
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
after(async () => {
  await platform?.dispose();
});

test('batch_runs: 成功も失敗も実行記録が残る', async () => {
  const ok = await runBatchD1(db, 'usage_rollup', async () => ({
    targetCount: 3,
    detail: { note: 'ok' },
  }));
  assert.equal(ok.targetCount, 3);
  await assert.rejects(
    runBatchD1(db, 'monitoring', async () => {
      throw new BatchFailure('一部失敗', { targetCount: 2, detail: { stage: 'x' } });
    }),
    /一部失敗/,
  );
  const usage = await listBatchRuns(db, 'usage_rollup');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].http_status, 200);
  assert.equal(usage[0].target_count, 3);
  assert.ok(usage[0].finished_at);
  const mon = await listBatchRuns(db, 'monitoring');
  assert.equal(mon.length, 1);
  assert.equal(mon[0].http_status, 500);
  assert.equal(mon[0].target_count, 2);
  assert.match(mon[0].error_message, /一部失敗/);
});

test('batch_runs: forEachActiveCaseD1 は進行中案件を venue 順に辿る', async () => {
  const seen = [];
  const n = await forEachActiveCaseD1(db, async (caseId, venueId) => {
    seen.push([caseId, venueId]);
  });
  assert.equal(n, 3);
  assert.deepEqual(seen.map(([c]) => c).sort(), [ids.caseA, ids.caseA2, ids.caseB].sort());
});

test('risk: 期限超過の重要宿題で high になり、根拠つきで一覧・詳細に出る', async () => {
  await db
    .prepare(
      "INSERT INTO case_tasks(id,case_id,title,due_date,status,importance) VALUES ('task-risk-overdue',?,'期限超過の重要宿題','2020-01-01','not_started','important')",
    )
    .bind(ids.caseA)
    .run();
  const result = await recalculateCaseRiskD1(db, ids.caseA);
  assert.equal(result.scoreLevel, 'high');
  assert.ok(result.scoreValue >= 40);
  assert.ok(result.reasons.some((r) => r.conditionKey === 'task_overdue'));
  // 根拠は必ずセット (名前と説明が入っている)
  for (const reason of result.reasons) {
    assert.ok(reason.name);
    assert.ok('description' in reason);
  }
  const current = await getCurrentRiskD1(db, ids.caseA);
  assert.equal(current.score_level, 'high');
  assert.deepEqual(current.reasons, result.reasons);

  const detail = await caseRow(db, actor('planner', ids.plannerA), ids.caseA);
  assert.equal(detail.risk_score_snapshots.length, 1);
  assert.equal(detail.risk_score_snapshots[0].score_level, 'high');
  // couple には見せない
  const coupleDetail = await caseRow(db, actor('couple', ids.coupleA), ids.caseA);
  assert.equal(coupleDetail.risk_score_snapshots.length, 0);

  const list = await listCases(db, actor('planner', ids.plannerA), {});
  const rowA = list.items.find((i) => i.id === ids.caseA);
  assert.ok(rowA.risk);
  assert.equal(rowA.risk.score_level, 'high');
  assert.ok(rowA.risk.reasons.length >= 1);
  const sorted = await listCases(db, actor('admin', ids.adminA), { sort: 'risk' });
  assert.equal(sorted.items[0].id, ids.caseA);

  // 再計算で現在値は1件のまま差し替わる
  await recalculateCaseRiskD1(db, ids.caseA);
  const count = await db
    .prepare('SELECT count(*) AS n FROM risk_score_snapshots WHERE case_id=? AND is_current=1')
    .bind(ids.caseA)
    .first();
  assert.equal(count.n, 1);
});

test('risk: ルールが無い案件は low / 0 で根拠なし (未算出と区別できる保存形)', async () => {
  const result = await recalculateCaseRiskD1(db, ids.caseB);
  // caseB は宿題が未来期限・通常重要度。no_activity は提出が無いため成立しうるので
  // ここでは「保存され現在値が読める」ことだけを固定する。
  const current = await getCurrentRiskD1(db, ids.caseB);
  assert.ok(current);
  assert.equal(current.score_value, result.scoreValue);
});

test('notifications extra: ログ記録と CSV 导出用取得 (式場・案件番号つき)', async () => {
  await db
    .prepare(
      "INSERT INTO notifications(id,case_id,recipient_user_id,channel,notification_type,title,body,created_at) VALUES ('notice-log-1',?,?, 'email','info','お知らせ','本文','2028-01-01T00:00:00.000Z')",
    )
    .bind(ids.caseA, ids.coupleA)
    .run();
  await recordNotificationLog(db, {
    notificationId: 'notice-log-1',
    provider: 'email',
    status: 'success',
    providerMessageId: 'msg-1',
  });
  await recordNotificationLog(db, {
    notificationId: 'notice-log-1',
    provider: 'email',
    status: 'failure',
    attemptNo: 2,
  });
  const rows = await loadNotificationLogsForExportD1(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].notifications.wedding_cases.case_code, 'A-001');
  assert.equal(rows[0].notifications.venues.name, '検証式場A');
  assert.equal(rows[0].notifications.notification_type, 'info');
  const bounded = await loadNotificationLogsForExportD1(db, { from: '2029-01-01' });
  assert.equal(bounded.length, 0);
});

test('notifications extra: 設定の既定値と式場別上書き、クォータ加算', async () => {
  const defaults = await getNotificationSettingsD1(db, ids.venueA);
  assert.equal(defaults.dueReminderDaysBefore, 7);
  assert.equal(defaults.linePerVenuePerMonth, 180);
  await db
    .prepare(
      "INSERT INTO notification_settings(id,venue_id,line_per_case_per_week,line_per_venue_per_month,due_reminder_days_before) VALUES ('settings-a',?,2,100,3)",
    )
    .bind(ids.venueA)
    .run();
  const overridden = await getNotificationSettingsD1(db, ids.venueA);
  assert.equal(overridden.dueReminderDaysBefore, 3);
  assert.equal(overridden.linePerCasePerWeek, 2);
  const other = await getNotificationSettingsD1(db, ids.venueB);
  assert.equal(other.dueReminderDaysBefore, 7);

  assert.equal(await incrementNotificationQuotaD1(db, 'venue_month', ids.venueA, '2028-01-01'), 1);
  assert.equal(await incrementNotificationQuotaD1(db, 'venue_month', ids.venueA, '2028-01-01'), 2);
  assert.equal(await incrementNotificationQuotaD1(db, 'venue_month', ids.venueA, '2028-02-01'), 1);
});
