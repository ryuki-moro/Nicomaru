import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ids = Object.fromEntries(
  [
    'venueA',
    'venueB',
    'system',
    'adminA',
    'adminB',
    'plannerA',
    'plannerA2',
    'plannerB',
    'coupleA',
    'coupleB',
    'suspended',
    'invited',
    'deleted',
    'caseA',
    'caseA2',
    'caseB',
    'planA',
    'planB',
  ].map((name, n) => [name, uuid(n + 1)]),
);

export async function seedAppFixtures(db, encode = (value) => value) {
  const password = randomBytes(24).toString('base64url');
  const hash = await hashPassword(password);
  const now = Date.now();
  const users = [
    ['system', null, 'system_admin', 'active'],
    ['adminA', 'venueA', 'admin', 'active'],
    ['adminB', 'venueB', 'admin', 'active'],
    ['plannerA', 'venueA', 'planner', 'active'],
    ['plannerA2', 'venueA', 'planner', 'active'],
    ['plannerB', 'venueB', 'planner', 'active'],
    ['coupleA', 'venueA', 'couple', 'active'],
    ['coupleB', 'venueB', 'couple', 'active'],
    ['suspended', 'venueA', 'planner', 'suspended'],
    ['invited', 'venueA', 'planner', 'invited'],
    ['deleted', 'venueA', 'planner', 'deleted'],
  ];
  const statements = ['A', 'B'].map((suffix) =>
    db
      .prepare('INSERT INTO venues(id,name,code) VALUES (?,?,?)')
      .bind(ids[`venue${suffix}`], `検証式場${suffix}`, `VENUE${suffix}`),
  );
  for (const [name, venue, role, status] of users) {
    statements.push(
      db
        .prepare(
          'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)',
        )
        .bind(ids[name], name, `${name.toLowerCase()}@example.test`, now, now),
      db
        .prepare(
          "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,?,?)",
        )
        .bind(`account-${name}`, ids[name], ids[name], hash, now, now),
      db
        .prepare('INSERT INTO user_profiles VALUES (?,?,?,?)')
        .bind(ids[name], venue ? ids[venue] : null, role, status),
    );
  }
  for (const suffix of ['A', 'B']) {
    const templates = [
      {
        taskTemplateId: uuid(suffix === 'A' ? 90 : 91),
        title: '出席者の確認',
        description: null,
        submissionFormat: 'text',
        allowedFileTypes: [],
        options: {},
        importance: 'normal',
        dueOffsetDays: 30,
        dueOffsetDaysOverride: null,
        isRequired: true,
        displayOrder: 0,
      },
    ];
    statements.push(
      db
        .prepare('INSERT INTO plan_types(id,venue_id,name,templates_json) VALUES (?,?,?,?)')
        .bind(
          ids[`plan${suffix}`],
          ids[`venue${suffix}`],
          `標準プラン${suffix}`,
          JSON.stringify(templates),
        ),
    );
  }
  for (const [key, venue, planner, code, couple] of [
    ['caseA', 'venueA', 'plannerA', 'A-001', 'coupleA'],
    ['caseA2', 'venueA', 'plannerA2', 'A-002', null],
    ['caseB', 'venueB', 'plannerB', 'B-001', 'coupleB'],
  ]) {
    const suffix = venue === 'venueA' ? 'A' : 'B';
    statements.push(
      db
        .prepare(
          "INSERT INTO wedding_cases(id,venue_id,primary_planner_id,plan_type_id,case_code,wedding_date,guest_count,notes) VALUES (?,?,?,?,?,'2027-06-20',50,?)",
        )
        .bind(ids[key], ids[venue], ids[planner], ids[`plan${suffix}`], code, `内部メモ${code}`),
    );
    for (const partner of ['groom', 'bride'])
      statements.push(
        db
          .prepare('INSERT INTO couple_profiles VALUES (?,?,?,?,?,?)')
          .bind(
            ids[key],
            partner,
            partner === 'bride' && couple ? ids[couple] : null,
            encode(`${code} ${partner === 'groom' ? '太郎' : '花子'}`),
            partner === 'bride' ? encode(`${code.toLowerCase()}@example.test`) : null,
            partner === 'bride' ? 1 : 0,
          ),
      );
    statements.push(
      db
        .prepare(
          "INSERT INTO case_tasks(id,case_id,task_template_id,title,due_date,due_offset_days) VALUES (?,?,?,'出席者の確認','2027-05-21',30)",
        )
        .bind(`task-${key}`, ids[key], uuid(suffix === 'A' ? 90 : 91)),
    );
  }
  await db.batch(statements);
  return {
    ids,
    users: Object.fromEntries(
      users.map(([name]) => [name, { email: `${name.toLowerCase()}@example.test`, password }]),
    ),
  };
}
