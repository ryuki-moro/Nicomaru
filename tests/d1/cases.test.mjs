import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptPii } from '../../src/lib/crypto.ts';
import { readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures, ids } from '../../scripts/d1-fixtures.mjs';
import { caseRow, listCases, patchCase } from '../../src/lib/d1/cases.ts';

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
after(async () => {
  await platform?.dispose();
});

test('4ロールの参照範囲と他式場・同僚担当の拒否', async () => {
  assert.equal((await listCases(db, actor('system_admin', ids.system))).items.length, 3);
  assert.equal((await listCases(db, actor('admin', ids.adminA))).items.length, 2);
  assert.equal((await listCases(db, actor('planner', ids.plannerA))).items.length, 1);
  assert.equal((await listCases(db, actor('couple', ids.coupleA))).items.length, 1);
  for (const user of [
    actor('admin', ids.adminA),
    actor('planner', ids.plannerA),
    actor('couple', ids.coupleA),
  ]) {
    await assert.rejects(caseRow(db, user, ids.caseB), { code: 'NOT_FOUND' });
  }
  await assert.rejects(caseRow(db, actor('planner', ids.plannerA), ids.caseA2), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(caseRow(db, actor('couple', ids.coupleA), ids.caseA2), {
    code: 'NOT_FOUND',
  });
});
test('coupleの更新、plannerの担当変更、他式場の更新を拒否して元データを維持', async () => {
  await assert.rejects(patchCase(db, actor('couple', ids.coupleA), ids.caseA, { guestCount: 99 }), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    patchCase(db, actor('planner', ids.plannerA), ids.caseA, { primaryPlannerId: ids.plannerA2 }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(patchCase(db, actor('admin', ids.adminA), ids.caseB, { guestCount: 99 }), {
    code: 'NOT_FOUND',
  });
  assert.equal((await caseRow(db, actor('system_admin', ids.system), ids.caseB)).guest_count, 50);
});
test('本体編集項目を更新し、日程のプレビューは未確定の間書き込まない', async () => {
  const user = actor('planner', ids.plannerA);
  const preview = await patchCase(db, user, ids.caseA, { weddingDate: '2027-06-21' });
  assert.equal(preview.applied, false);
  assert.equal((await caseRow(db, user, ids.caseA)).wedding_date, '2027-06-20');
  const result = await patchCase(db, user, ids.caseA, {
    weddingDate: '2027-06-21',
    guestCount: 80,
    groomName: '更新 太郎',
    confirmed: true,
  });
  assert.equal(result.applied, true);
  const row = await caseRow(db, user, ids.caseA);
  assert.equal(row.guest_count, 80);
  assert.equal(row.wedding_date, '2027-06-21');
  assert.equal(row.couple_profiles.find((p) => p.partner_role === 'groom')?.full_name, '更新 太郎');
  assert.equal(row.case_tasks[0].due_date, '2027-05-22');
});
test('管理者でも他式場のプラン・担当を指定できず、一括更新を部分適用しない', async () => {
  const user = actor('admin', ids.adminA);
  await assert.rejects(
    patchCase(db, user, ids.caseA, { primaryPlannerId: ids.plannerB, guestCount: 999 }),
    { code: 'VALIDATION_ERROR' },
  );
  await assert.rejects(patchCase(db, user, ids.caseA, { planTypeId: ids.planB, guestCount: 999 }), {
    code: 'VALIDATION_ERROR',
  });
  assert.equal((await caseRow(db, user, ids.caseA)).guest_count, 80);
});

test('氏名・メールを暗号化し、一覧では復号して検索できる', async () => {
  const user = actor('admin', ids.adminA);
  await db
    .prepare("UPDATE couple_profiles SET email=? WHERE case_id=? AND partner_role='groom'")
    .bind(encryptPii('groom@example.test'), ids.caseA)
    .run();
  await patchCase(db, user, ids.caseA, { contactEmail: 'updated@example.test' });
  const stored = await db
    .prepare("SELECT full_name,email FROM couple_profiles WHERE case_id=? AND partner_role='bride'")
    .bind(ids.caseA)
    .first();
  assert.match(stored.full_name, /^v1:/);
  assert.match(stored.email, /^v1:/);
  assert.equal((await listCases(db, user, { keyword: '更新 太郎' })).items.length, 1);
  assert.equal(
    (await caseRow(db, user, ids.caseA)).couple_profiles.find((p) => p.is_primary_contact).email,
    'updated@example.test',
  );
  assert.equal(
    (await caseRow(db, user, ids.caseA)).couple_profiles.find((p) => p.partner_role === 'groom')
      .email,
    'groom@example.test',
  );
});

test('adminはアーカイブ・復元、system_adminは別式場の更新が可能', async () => {
  const admin = actor('admin', ids.adminA);
  await patchCase(db, admin, ids.caseA2, { archived: true });
  await assert.rejects(caseRow(db, actor('planner', ids.plannerA2), ids.caseA2), {
    code: 'NOT_FOUND',
  });
  assert.equal((await listCases(db, admin, { scope: 'archived' })).items.length, 1);
  await patchCase(db, admin, ids.caseA2, { archived: false });
  const system = actor('system_admin', ids.system, null);
  await patchCase(db, system, ids.caseB, { guestCount: 65 });
  assert.equal((await caseRow(db, system, ids.caseB)).guest_count, 65);
});

test('同式場のプラン変更も差分確認後に適用し、宿題の追加・waivedを維持', async () => {
  const plan = '10000000-0000-4000-8000-000000000099';
  const template = {
    taskTemplateId: 'new-template',
    title: '新プランの宿題',
    description: null,
    submissionFormat: 'text',
    allowedFileTypes: [],
    options: {},
    importance: 'normal',
    dueOffsetDays: 10,
    dueOffsetDaysOverride: null,
    isRequired: true,
    displayOrder: 0,
  };
  await db
    .prepare('INSERT INTO plan_types(id,venue_id,name,templates_json) VALUES (?,?,?,?)')
    .bind(plan, ids.venueA, '変更プラン', JSON.stringify([template]))
    .run();
  const user = actor('admin', ids.adminA);
  const preview = await patchCase(db, user, ids.caseA2, { planTypeId: plan });
  assert.equal(preview.preview.added.length, 1);
  assert.equal(preview.preview.waived.length, 1);
  await patchCase(db, user, ids.caseA2, { planTypeId: plan, confirmed: true });
  const row = await caseRow(db, user, ids.caseA2);
  assert.equal(row.case_tasks.filter((t) => t.status === 'waived').length, 1);
  assert.equal(row.case_tasks.filter((t) => t.task_template_id === 'new-template').length, 1);
});

test('案件更新途中のDB例外ではプロフィール・監査もロールバックする', async () => {
  const user = actor('admin', ids.adminA);
  const before = await caseRow(db, user, ids.caseA);
  const audits = await db.prepare('SELECT count(*) AS n FROM case_audit').first();
  await db
    .prepare(
      "CREATE TRIGGER fail_case_update BEFORE UPDATE ON wedding_cases BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    )
    .run();
  try {
    await assert.rejects(
      patchCase(db, user, ids.caseA, { groomName: '書き込まれてはいけない', guestCount: 100 }),
    );
  } finally {
    await db.prepare('DROP TRIGGER fail_case_update').run();
  }
  assert.deepEqual((await caseRow(db, user, ids.caseA)).couple_profiles, before.couple_profiles);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM case_audit').first()).n, audits.n);
});

test('読取後の競合・アカウント停止では、古い権限で部分書込しない', async () => {
  const user = actor('admin', ids.adminA);
  const before = await caseRow(db, user, ids.caseA);
  const racing = {
    prepare: db.prepare.bind(db),
    batch: async (statements) => {
      await db
        .prepare('UPDATE wedding_cases SET version=version+1 WHERE id=?')
        .bind(ids.caseA)
        .run();
      return db.batch(statements);
    },
  };
  await assert.rejects(patchCase(racing, user, ids.caseA, { groomName: '競合後の上書き' }), {
    code: 'CONFLICT',
  });
  assert.deepEqual((await caseRow(db, user, ids.caseA)).couple_profiles, before.couple_profiles);
  await db.prepare("UPDATE user_profiles SET status='suspended' WHERE id=?").bind(user.id).run();
  try {
    assert.equal((await listCases(db, user)).items.length, 0);
    await assert.rejects(caseRow(db, user, ids.caseA), { code: 'NOT_FOUND' });
    await assert.rejects(patchCase(db, user, ids.caseA, { guestCount: 999 }), {
      code: 'NOT_FOUND',
    });
  } finally {
    await db.prepare("UPDATE user_profiles SET status='active' WHERE id=?").bind(user.id).run();
  }
});

test('担当変更の検証後に所属が変わっても別式場の担当を割り当てない', async () => {
  const user = actor('admin', ids.adminA);
  const before = await caseRow(db, user, ids.caseA);
  const racing = {
    prepare: db.prepare.bind(db),
    batch: async (statements) => {
      await db
        .prepare('UPDATE user_profiles SET venue_id=? WHERE id=?')
        .bind(ids.venueB, ids.plannerA2)
        .run();
      return db.batch(statements);
    },
  };
  try {
    await assert.rejects(
      patchCase(racing, user, ids.caseA, {
        primaryPlannerId: ids.plannerA2,
        groomName: '部分変更禁止',
      }),
      { code: 'CONFLICT' },
    );
    const row = await caseRow(db, user, ids.caseA);
    assert.equal(row.primary_planner_id, before.primary_planner_id);
    assert.deepEqual(row.couple_profiles, before.couple_profiles);
  } finally {
    await db
      .prepare('UPDATE user_profiles SET venue_id=? WHERE id=?')
      .bind(ids.venueA, ids.plannerA2)
      .run();
  }
});
