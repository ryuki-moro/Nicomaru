import { hashPassword } from 'better-auth/crypto';

import { DEMO_CASES, DEMO_PLANNER, DEMO_PLAN_TYPES } from './demo/scenario.ts';

/** デモ版（npm run demo）の架空データ。宿題テンプレートは supabase/seed.sql と同じ内容。 */
const VENUE_ID = '11111111-1111-4111-8111-111111111111';
const PLANNER_ID = '41111111-1111-4111-8111-111111111111';
const DEMO_COUPLE_KEY = 'demo-02';

const TEMPLATES = [
  [
    '101',
    'ゲストリスト提出',
    '招待するゲストのお名前・ご住所をCSVでご提出ください。',
    'file',
    ['csv'],
    60,
    'critical',
    {},
  ],
  [
    '102',
    '席次表の確認',
    '席次表の最終確認をお願いします。',
    'file',
    ['jpg', 'png'],
    21,
    'critical',
    {},
  ],
  [
    '103',
    'BGMリクエスト',
    '入場・歓談・退場で流したい曲をご記入ください。',
    'text',
    [],
    45,
    'normal',
    {},
  ],
  [
    '104',
    '料理コースの選択',
    'ご列席者にお出しするお料理のコースをお選びください。',
    'select',
    [],
    40,
    'important',
    { choices: ['スタンダード', 'グレードアップ', 'シェフのおまかせ'] },
  ],
  [
    '105',
    '引き出物の選択',
    '引き出物・引き菓子をお選びください。',
    'select',
    [],
    35,
    'important',
    { choices: ['カタログギフトA', 'カタログギフトB', '食器セット'] },
  ],
  [
    '106',
    'プロフィールムービーの入稿',
    'プロフィールムービーで使用するお写真をご提出ください。',
    'file',
    ['jpg', 'png'],
    30,
    'normal',
    {},
  ],
  [
    '107',
    '当日の進行表の確認',
    '当日の進行表をご確認ください。ご質問があればお知らせください。',
    'none',
    [],
    14,
    'important',
    {},
  ],
  ['108', '最終お支払いのご確認', 'お支払い金額の最終確認です。', 'none', [], 7, 'critical', {}],
].map(([n, title, description, format, fileTypes, offset, importance, options], index) => ({
  taskTemplateId: `31111111-1111-4111-8111-111111111${n}`,
  title,
  description,
  submissionFormat: format,
  allowedFileTypes: fileTypes,
  options,
  importance,
  dueOffsetDays: offset,
  dueOffsetDaysOverride: null,
  isRequired: n !== '106',
  displayOrder: index,
}));

const PHOTO_PLAN = { 106: 21, 107: 10, 108: 7 };
const templatesFor = (plan) =>
  plan === 'フォト婚'
    ? TEMPLATES.filter((t) => t.taskTemplateId.slice(-3) in PHOTO_PLAN).map((t, index) => ({
        ...t,
        dueOffsetDaysOverride: PHOTO_PLAN[t.taskTemplateId.slice(-3)],
        displayOrder: index,
      }))
    : TEMPLATES;

const jstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shift = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export async function seedDemoFixtures(db, encode, password) {
  const hash = await hashPassword(password);
  const now = Date.now();
  const today = jstToday();
  const counters = new Map();
  const statements = [];
  const run = (sql, ...args) => statements.push(db.prepare(sql).bind(...args));
  const addUser = (id, name, email, role) => {
    run(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)',
      id,
      name,
      email,
      now,
      now,
    );
    run(
      "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,?,?)",
      `account-${id}`,
      id,
      id,
      hash,
      now,
      now,
    );
    run(
      "INSERT INTO user_profiles(id,venue_id,role,status) VALUES (?,?,?,'active')",
      id,
      VENUE_ID,
      role,
    );
  };

  run('INSERT INTO venues(id,name,code) VALUES (?,?,?)', VENUE_ID, 'サンプル式場', 'BRIDAL01');
  addUser(PLANNER_ID, DEMO_PLANNER.displayName, DEMO_PLANNER.email, 'planner');
  for (const [name, id] of Object.entries(DEMO_PLAN_TYPES))
    run(
      'INSERT INTO plan_types(id,venue_id,name,templates_json) VALUES (?,?,?,?)',
      id,
      VENUE_ID,
      name,
      JSON.stringify(templatesFor(name)),
    );

  let coupleEmail;
  DEMO_CASES.forEach((demo, caseIndex) => {
    const caseId = uuid('51111111', caseIndex + 1);
    const weddingDate = shift(today, demo.daysUntilWedding);
    // 本番（src/lib/d1/onboarding.ts）と同じく挙式年ごとに採番する
    const year = Number(weddingDate.slice(0, 4));
    counters.set(year, (counters.get(year) ?? 0) + 1);
    run(
      'INSERT INTO wedding_cases(id,venue_id,primary_planner_id,plan_type_id,case_code,wedding_date,guest_count) VALUES (?,?,?,?,?,?,?)',
      caseId,
      VENUE_ID,
      PLANNER_ID,
      DEMO_PLAN_TYPES[demo.planType],
      `BRIDAL01-${year}-${String(counters.get(year)).padStart(4, '0')}`,
      weddingDate,
      demo.guestCount,
    );
    let coupleUser;
    for (const role of ['groom', 'bride']) {
      const partner = demo[role];
      const userId = partner.registered
        ? uuid(role === 'groom' ? '61111111' : '62222222', caseIndex + 1)
        : null;
      if (userId) {
        addUser(userId, partner.name, partner.email, 'couple');
        coupleUser ??= userId;
        if (demo.key === DEMO_COUPLE_KEY) coupleEmail ??= partner.email;
      }
      const primary = demo.primaryContact === role;
      run(
        'INSERT INTO couple_profiles(case_id,partner_role,user_id,full_name,email,is_primary_contact) VALUES (?,?,?,?,?,?)',
        caseId,
        role,
        userId,
        encode(partner.name),
        primary ? encode(partner.email) : null,
        primary ? 1 : 0,
      );
    }
    templatesFor(demo.planType).forEach((t, taskIndex) => {
      const taskId = uuid('71111111', caseIndex * 100 + taskIndex + 1);
      const offset = t.dueOffsetDaysOverride ?? t.dueOffsetDays;
      const submission = demo.submissions.find((s) => s.template === t.title);
      run(
        'INSERT INTO case_tasks(id,case_id,task_template_id,title,description,due_date,due_offset_days,status,importance,display_order,submission_format,options,allowed_file_types,is_required,confirmed_by,confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        taskId,
        caseId,
        t.taskTemplateId,
        t.title,
        t.description,
        shift(weddingDate, -offset),
        offset,
        submission?.result ?? 'not_started',
        t.importance,
        t.displayOrder,
        t.submissionFormat,
        JSON.stringify(t.options),
        JSON.stringify(t.allowedFileTypes),
        t.isRequired ? 1 : 0,
        submission?.result === 'confirmed' ? PLANNER_ID : null,
        submission?.result === 'confirmed' ? new Date(now).toISOString() : null,
      );
      if (!submission || !coupleUser) return;
      const reviewed = submission.result !== 'submitted';
      run(
        'INSERT INTO task_submissions(id,case_task_id,submitted_by,submission_type,text_value,selected_value,review_status,planner_feedback,reviewed_by,reviewed_at,submitted_at,is_latest) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)',
        uuid('81111111', caseIndex * 100 + taskIndex + 1),
        taskId,
        coupleUser,
        t.submissionFormat,
        encode(submission.text ?? null),
        submission.selected ?? null,
        submission.result,
        encode(submission.feedback ?? null),
        reviewed ? PLANNER_ID : null,
        reviewed ? new Date(now).toISOString() : null,
        new Date(now - 86_400_000).toISOString(),
      );
    });
  });
  for (const [year, value] of counters)
    run('INSERT INTO case_counters(venue_id,year,value) VALUES (?,?,?)', VENUE_ID, year, value);
  await db.batch(statements);
  return { planner: DEMO_PLANNER.email, couple: coupleEmail };
}
