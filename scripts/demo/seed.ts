/**
 * 模擬データの投入（Issue #24）。
 *
 * 【なぜ SQL を直接書かず、アプリと同じ関数を呼ぶのか】
 * 案件登録・宿題割当・提出・確認は、画面から操作したときと同じ DB 関数
 * （create_wedding_case／assign_case_tasks／submit_task_atomic／review_submission）を、
 * 同じ利用者（プランナー・新郎新婦）の権限で呼ぶ。RLS も業務ルールもそのまま効くので、
 * 「デモでは動いたが画面からは作れない状態」は生まれない。
 * 期限の逆算・暗号化・招待トークンも、アプリ本体の同じ関数（src/lib）を使う。
 *
 * 所有者権限（RLS を通らない）で行うのは、アプリでも Service Role で行っている次の2つだけ。
 *   - プランナーの user_profiles 作成（bootstrap-demo-planner.mts と同じ）
 *   - 招待URLからの初回登録（/api/auth/initial-register と同じ手順）
 *
 * Auth ユーザーの作成だけは DB からはできないので、呼び出し側から {@link DemoAuth} で受け取る。
 * scripts/seed-demo.mts は Supabase の Admin API を、テストは auth.users のスタブを渡す。
 */
import { emailHash, encryptPii } from '@/lib/crypto';
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationMaxUses,
} from '@/lib/services/invitations';
import {
  formatIsoDate,
  parseIsoDate,
  phaseNameFor,
  planTasks,
  type IsoDate,
  type TemplateForAssign,
} from '@/lib/services/schedule';

import {
  DEMO_CASES,
  DEMO_NOTE_PREFIX,
  DEMO_PLAN_TYPES,
  DEMO_PLANNER,
  DEMO_TEMPLATES,
  DEMO_VENUE_ID,
  demoNote,
  type DemoCase,
  type DemoPartner,
} from './scenario';

/** PGlite（テスト）と pg（ローカル／共有デモ）の両方で動くように、必要な形だけを決める */
export interface DemoDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** RLS を通らない所有者権限で実行する */
  asOwner<T>(fn: () => Promise<T>): Promise<T>;
  /** authenticated ロール＋指定ユーザーの JWT で実行する（画面からの操作と同じ権限） */
  asUser<T>(authUserId: string, fn: () => Promise<T>): Promise<T>;
}

export interface DemoAuth {
  /** Auth ユーザーを用意して ID を返す。既にあればそれを返す（作り直しても増えない） */
  ensureUser(email: string, options: { displayName: string; password?: string }): Promise<string>;
}

export interface SeedOptions {
  /** プランナーのログイン用パスワード */
  plannerPassword: string;
  /** 「今日」（日本時間 YYYY-MM-DD）。挙式日はここから数える */
  today: IsoDate;
  /** 招待URLの組み立てに使う（未登録の新郎新婦に渡すURL） */
  appBaseUrl: string;
}

export interface SeededCase {
  key: string;
  purpose: string;
  caseId: string;
  caseCode: string;
  weddingDate: IsoDate;
  /** 未登録の側の招待URL。デモで「初回登録」を実演するときに使う */
  pendingInviteUrls: { partnerRole: 'groom' | 'bride'; name: string; url: string }[];
  registeredEmails: string[];
}

export interface SeedResult {
  plannerEmail: string;
  created: SeededCase[];
  /** 既に同じ目印の案件があったため作らなかったもの */
  skipped: string[];
}

interface TemplateRow {
  task_template_id: string;
  name: string;
  description: string | null;
  submission_format: TemplateForAssign['submissionFormat'];
  allowed_file_types: string[] | null;
  default_options: Record<string, unknown> | null;
  due_offset_days: number;
  importance: TemplateForAssign['importance'];
  due_offset_days_override: number | null;
  is_required: boolean;
  display_order: number;
}

/** 日付に日数を足す（どちらも日本時間の暦日として扱う） */
export function addDays(date: IsoDate, days: number): IsoDate {
  const base = parseIsoDate(date);
  base.setUTCDate(base.getUTCDate() + days);
  return formatIsoDate(base);
}

// ------------------------------------------------------------------ プランナー

async function ensureProfile(
  db: DemoDb,
  authUserId: string,
  values: { role: 'planner' | 'couple'; email: string; displayName: string },
): Promise<string> {
  return db.asOwner(async () => {
    const existing = await db.query<{ id: string; role: string }>(
      'select id, role from user_profiles where email = $1',
      [values.email],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].role !== values.role) {
        throw new Error(
          `${values.email} は別の役割（${existing.rows[0].role}）で登録済みです。デモ用のアドレスを変えてください`,
        );
      }
      return existing.rows[0].id;
    }
    const inserted = await db.query<{ id: string }>(
      `insert into user_profiles (auth_user_id, venue_id, role, display_name, email, status)
       values ($1, $2, $3, $4, $5, 'active') returning id`,
      [authUserId, DEMO_VENUE_ID, values.role, values.displayName, values.email],
    );
    return inserted.rows[0].id;
  });
}

// ------------------------------------------------------------------ 案件

async function loadTemplates(db: DemoDb, planTypeId: string): Promise<TemplateForAssign[]> {
  // src/lib/services/planTemplates.ts の loadPlanTemplates と同じ読み出し・同じ写し方
  const { rows } = await db.asOwner(() =>
    db.query<TemplateRow>(
      `select t.id as task_template_id, t.name, t.description, t.submission_format,
              t.allowed_file_types, t.default_options, t.due_offset_days, t.importance,
              p.due_offset_days_override, p.is_required, p.display_order
         from plan_task_templates p
         join task_templates t on t.id = p.task_template_id
        where p.plan_type_id = $1 and t.active
        order by p.display_order`,
      [planTypeId],
    ),
  );
  return rows.map((row) => ({
    taskTemplateId: row.task_template_id,
    title: row.name,
    description: row.description,
    submissionFormat: row.submission_format,
    allowedFileTypes: row.allowed_file_types ?? [],
    options: row.default_options ?? {},
    importance: row.importance,
    dueOffsetDays: row.due_offset_days,
    dueOffsetDaysOverride: row.due_offset_days_override,
    isRequired: row.is_required,
    displayOrder: row.display_order,
  }));
}

async function createCase(
  db: DemoDb,
  plannerAuthId: string,
  demo: DemoCase,
  weddingDate: IsoDate,
): Promise<{ caseId: string; caseCode: string; tokens: Record<'groom' | 'bride', string> }> {
  // POST /api/cases と同じ組み立て
  const tokens = { groom: generateInvitationToken(), bride: generateInvitationToken() };
  const expiresAt = invitationExpiresAt('initial_registration').toISOString();
  const primary = demo.primaryContact === 'groom' ? demo.groom : demo.bride;

  const created = await db.asUser(plannerAuthId, () =>
    db.query<{ result: { case_id: string; case_code: string } }>(
      `select create_wedding_case(
         $1::date, null::time, $2::uuid, 'email', $3::integer, null::text, $4::text, $5::text,
         $6::text, $7::text, $8::text, $9::text, $10::jsonb) as result`,
      [
        weddingDate,
        DEMO_PLAN_TYPES[demo.planType],
        demo.guestCount,
        demoNote(demo.key, demo.purpose),
        demo.primaryContact,
        encryptPii(demo.groom.name),
        encryptPii(demo.bride.name),
        encryptPii(primary.email),
        emailHash(primary.email),
        JSON.stringify(
          (['groom', 'bride'] as const).map((role) => ({
            target_partner_role: role,
            token_hash: hashInvitationToken(tokens[role]),
            channel: 'email',
            purpose: 'initial_registration',
            expires_at: expiresAt,
            max_uses: invitationMaxUses('initial_registration'),
          })),
        ),
      ],
    ),
  );
  const { case_id: caseId, case_code: caseCode } = created.rows[0].result;

  // POST /api/cases/{caseId}/assign-tasks と同じ組み立て
  const planned = planTasks(weddingDate, await loadTemplates(db, DEMO_PLAN_TYPES[demo.planType]));
  await db.asUser(plannerAuthId, () =>
    db.query('select assign_case_tasks($1::uuid, $2::jsonb)', [
      caseId,
      JSON.stringify(
        planned.map((task) => ({
          task_template_id: task.taskTemplateId,
          title: task.title,
          description: task.description,
          submission_format: task.submissionFormat,
          allowed_file_types: task.allowedFileTypes,
          options: task.options,
          is_required: task.isRequired,
          importance: task.importance,
          due_date: task.dueDate,
          display_order: task.displayOrder,
          phase_name: phaseNameFor(weddingDate, task.dueDate),
        })),
      ),
    ]),
  );

  return { caseId, caseCode, tokens };
}

// ------------------------------------------------------------------ 初回登録

/**
 * /api/auth/initial-register と同じ手順で、招待URLから登録した状態にする。
 * 招待の消費 → user_profiles → couple_profiles への紐付け → 連絡履歴。
 */
async function registerPartner(
  db: DemoDb,
  auth: DemoAuth,
  caseId: string,
  partnerRole: 'groom' | 'bride',
  partner: DemoPartner,
  token: string,
): Promise<string> {
  const authUserId = await auth.ensureUser(partner.email, { displayName: partner.name });
  const profileId = await ensureProfile(db, authUserId, {
    role: 'couple',
    email: partner.email,
    displayName: partner.name,
  });

  await db.asOwner(async () => {
    const consumed = await db.query<{ id: string }>(
      `select * from consume_invitation($1, 'initial_registration')`,
      [hashInvitationToken(token)],
    );
    if (!consumed.rows[0]) throw new Error(`招待を消費できませんでした: ${caseId} ${partnerRole}`);

    // 作り直しで前回の案件が消えていれば、同じ利用者を新しい案件へ付け替えられる
    await db.query(
      `update couple_profiles
          set user_profile_id = $1, email = $2, email_hash = $3
        where case_id = $4 and partner_role = $5`,
      [profileId, encryptPii(partner.email), emailHash(partner.email), caseId, partnerRole],
    );
    await db.query(
      `insert into communication_logs (case_id, channel, direction, source, summary, occurred_at, created_by)
       values ($1, 'in_app', 'inbound', 'initial_register',
               '新郎新婦が招待URLから初回登録を完了しました', now(), $2)`,
      [caseId, profileId],
    );
  });

  return authUserId;
}

// ------------------------------------------------------------------ 提出と確認

async function applySubmissions(
  db: DemoDb,
  demo: DemoCase,
  caseId: string,
  coupleAuthId: string,
  plannerAuthId: string,
): Promise<void> {
  for (const item of demo.submissions) {
    const task = await db.asOwner(() =>
      db.query<{ id: string; submission_format: string }>(
        'select id, submission_format from case_tasks where case_id = $1 and task_template_id = $2',
        [caseId, DEMO_TEMPLATES[item.template]],
      ),
    );
    const row = task.rows[0];
    if (!row) throw new Error(`${demo.key}: 宿題「${item.template}」が割り当てられていません（プラン種別を確認）`);

    // POST /api/tasks/{taskId}/submit と同じ。text_value は暗号化して渡す（13-1）
    const submitted = await db.asUser(coupleAuthId, () =>
      db.query<{ submission_id: string }>(
        'select * from submit_task_atomic($1, $2, $3, $4, null, null, false)',
        [row.id, row.submission_format, encryptPii(item.text ?? null), item.selected ?? null],
      ),
    );
    const submissionId = submitted.rows[0]?.submission_id;
    if (!submissionId) throw new Error(`${demo.key}: 「${item.template}」を提出できませんでした`);

    if (item.result === 'submitted') continue;

    // POST /api/submissions/{id}/review と同じ。不備ありはコメント必須
    if (item.result === 'needs_fix' && !item.feedback) {
      throw new Error(`${demo.key}: 不備ありには feedback が必要です`);
    }
    await db.asUser(plannerAuthId, () =>
      db.query('select * from review_submission($1, $2, $3)', [
        submissionId,
        item.result,
        item.feedback ?? null,
      ]),
    );
  }
}

// ------------------------------------------------------------------ 入口

/** デモの案件（目印つき）を消す。プランナー・新郎新婦のアカウントは残し、次回の投入で使い回す */
export async function resetDemo(db: DemoDb): Promise<number> {
  return db.asOwner(async () => {
    const deleted = await db.query<{ id: string }>(
      `delete from wedding_cases where venue_id = $1 and notes like $2 returning id`,
      [DEMO_VENUE_ID, `${DEMO_NOTE_PREFIX}%`],
    );
    return deleted.rows.length;
  });
}

export async function seedDemo(db: DemoDb, auth: DemoAuth, options: SeedOptions): Promise<SeedResult> {
  const plannerAuthId = await auth.ensureUser(DEMO_PLANNER.email, {
    displayName: DEMO_PLANNER.displayName,
    password: options.plannerPassword,
  });
  await ensureProfile(db, plannerAuthId, {
    role: 'planner',
    email: DEMO_PLANNER.email,
    displayName: DEMO_PLANNER.displayName,
  });

  const result: SeedResult = { plannerEmail: DEMO_PLANNER.email, created: [], skipped: [] };

  for (const demo of DEMO_CASES) {
    const exists = await db.asOwner(() =>
      db.query('select 1 from wedding_cases where venue_id = $1 and notes like $2', [
        DEMO_VENUE_ID,
        `${DEMO_NOTE_PREFIX}${demo.key}]%`,
      ]),
    );
    if (exists.rows.length > 0) {
      result.skipped.push(demo.key);
      continue;
    }

    const weddingDate = addDays(options.today, demo.daysUntilWedding);
    const { caseId, caseCode, tokens } = await createCase(db, plannerAuthId, demo, weddingDate);

    const seeded: SeededCase = {
      key: demo.key,
      purpose: demo.purpose,
      caseId,
      caseCode,
      weddingDate,
      pendingInviteUrls: [],
      registeredEmails: [],
    };

    let coupleAuthId: string | null = null;
    for (const role of ['groom', 'bride'] as const) {
      const partner = demo[role];
      if (partner.registered) {
        const id = await registerPartner(db, auth, caseId, role, partner, tokens[role]);
        coupleAuthId ??= id;
        seeded.registeredEmails.push(partner.email);
      } else {
        seeded.pendingInviteUrls.push({
          partnerRole: role,
          name: partner.name,
          url: buildInvitationUrl(options.appBaseUrl, tokens[role]),
        });
      }
    }

    if (demo.submissions.length > 0) {
      if (!coupleAuthId) throw new Error(`${demo.key}: 提出するには新郎新婦のどちらかが登録済みである必要があります`);
      await applySubmissions(db, demo, caseId, coupleAuthId, plannerAuthId);
    }

    result.created.push(seeded);
  }

  return result;
}
