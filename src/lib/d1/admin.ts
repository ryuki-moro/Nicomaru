/**
 * 管理系 CRUD の D1 版 (S01/S02 式場、T01〜T03 テンプレート・プラン種別、S03 集計)。
 *
 * テンプレートの正は正規化テーブル (task_templates / plan_task_templates, 0021)。
 * 案件割当が読む plan_types.templates_json は、保存のたびに正規化テーブルから再生成する
 * 派生キャッシュとして扱い、実行時コード (onboarding / cases) は変更しない。
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { z } from 'zod';

import type { AppUser } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { conflict, forbidden, notFound } from '@/lib/errors';
import type { TemplateForAssign } from '@/lib/services/schedule';
import type { planTypeSaveSchema, taskTemplateSchema } from '@/lib/validation';
import { listBatchRuns } from './batches';
import { listSystemAlerts, latestUsageSnapshot } from './monitoring';
import { loadNotificationLogsForExportD1 } from './notifications';

type Actor = Pick<AppUser, 'id' | 'role' | 'venueId'>;

const isUniqueError = (e: unknown) => e instanceof Error && /UNIQUE constraint/i.test(e.message);

async function audit(
  db: D1Database,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> = {},
) {
  try {
    await db
      .prepare(
        'INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail) VALUES (?,?,?,?,?)',
      )
      .bind(actorId, action, targetType, targetId, JSON.stringify(detail))
      .run();
  } catch {
    console.warn('[d1-admin] 監査記録を保存できませんでした', action, targetId);
  }
}

function requireSystemAdmin(actor: Actor) {
  if (actor.role !== 'system_admin') throw forbidden();
}
function requireAdminVenue(actor: Actor): string {
  if (actor.role !== 'admin' || !actor.venueId) throw forbidden();
  return actor.venueId;
}

// ---------------------------------------------------------------- 式場 (S01/S02)

export interface VenueRowD1 {
  id: string;
  name: string;
  code: string;
  contact_email: string | null;
  active: boolean;
  created_at: string;
  admins: string[];
}

export async function listVenuesAdmin(db: D1Database, actor: Actor, page = 1) {
  requireSystemAdmin(actor);
  const offset = (Math.max(page, 1) - 1) * LIST_PAGE_SIZE;
  const { results } = await db
    .prepare(
      'SELECT id,name,code,contact_email,active,created_at FROM venues ORDER BY code LIMIT ? OFFSET ?',
    )
    .bind(LIST_PAGE_SIZE + 1, offset)
    .all<{
      id: string;
      name: string;
      code: string;
      contact_email: string | null;
      active: number;
      created_at: string;
    }>();
  const hasNext = results.length > LIST_PAGE_SIZE;
  const rows: VenueRowD1[] = [];
  for (const v of results.slice(0, LIST_PAGE_SIZE)) {
    const { results: admins } = await db
      .prepare(
        "SELECT u.name AS display_name FROM user_profiles t JOIN \"user\" u ON u.id=t.id WHERE t.venue_id=? AND t.role='admin' AND t.status<>'deleted' ORDER BY u.name",
      )
      .bind(v.id)
      .all<{ display_name: string }>();
    rows.push({ ...v, active: Boolean(v.active), admins: admins.map((a) => a.display_name) });
  }
  return { rows, hasNext };
}

export async function getVenueD1(db: D1Database, actor: Actor, venueId: string) {
  requireSystemAdmin(actor);
  const row = await db
    .prepare('SELECT id,name,code,contact_email,active,created_at FROM venues WHERE id=?')
    .bind(venueId)
    .first<{
      id: string;
      name: string;
      code: string;
      contact_email: string | null;
      active: number;
      created_at: string;
    }>();
  if (!row) return null;
  return { ...row, active: Boolean(row.active) };
}

export async function createVenueD1(
  db: D1Database,
  actor: Actor,
  input: { name: string; code: string; contactEmail?: string | null; active: boolean },
) {
  requireSystemAdmin(actor);
  const id = crypto.randomUUID();
  try {
    await db
      .prepare('INSERT INTO venues(id,name,code,contact_email,active) VALUES (?,?,?,?,?)')
      .bind(id, input.name, input.code, input.contactEmail ?? null, input.active ? 1 : 0)
      .run();
  } catch (e) {
    if (isUniqueError(e)) throw conflict('その式場コードは既に使われています');
    throw e;
  }
  await audit(db, actor.id, 'venue.create', 'venues', id, { code: input.code });
  return { id };
}

export async function updateVenueD1(
  db: D1Database,
  actor: Actor,
  venueId: string,
  patch: { name?: string; contactEmail?: string | null; active?: boolean },
) {
  requireSystemAdmin(actor);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name=?');
    binds.push(patch.name);
  }
  if (patch.contactEmail !== undefined) {
    sets.push('contact_email=?');
    binds.push(patch.contactEmail);
  }
  if (patch.active !== undefined) {
    sets.push('active=?');
    binds.push(patch.active ? 1 : 0);
  }
  if (!sets.length) throw notFound('式場が見つかりません');
  sets.push('updated_at=CURRENT_TIMESTAMP');
  const r = await db
    .prepare(
      `UPDATE venues SET ${sets.join(',')} WHERE id=? RETURNING id,name,code,contact_email,active,updated_at`,
    )
    .bind(...binds, venueId)
    .first<{
      id: string;
      name: string;
      code: string;
      contact_email: string | null;
      active: number;
      updated_at: string;
    }>();
  if (!r) throw notFound('式場が見つかりません');
  await audit(db, actor.id, 'venue.update', 'venues', venueId, {
    changed: Object.keys(patch),
  });
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    contactEmail: r.contact_email,
    active: Boolean(r.active),
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------- テンプレート (T01/T02)

export interface TemplateRowD1 {
  id: string;
  name: string;
  description: string | null;
  submission_format: string;
  allowed_file_types: string[];
  default_options: Record<string, unknown>;
  due_offset_days: number;
  importance: string;
  is_required: boolean;
  active: boolean;
  planNames: string[];
}

interface StoredTemplate {
  id: string;
  name: string;
  description: string | null;
  submission_format: string;
  allowed_file_types: string;
  default_options: string;
  due_offset_days: number;
  importance: string;
  is_required: number;
  active: number;
}

const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

async function planNamesByTemplate(db: D1Database, venueId: string) {
  const { results } = await db
    .prepare(
      `SELECT pt.task_template_id AS tid, p.name AS plan_name FROM plan_task_templates pt
       JOIN plan_types p ON p.id=pt.plan_type_id WHERE p.venue_id=? ORDER BY p.name`,
    )
    .bind(venueId)
    .all<{ tid: string; plan_name: string }>();
  const map = new Map<string, string[]>();
  for (const r of results) {
    const list = map.get(r.tid) ?? [];
    list.push(r.plan_name);
    map.set(r.tid, list);
  }
  return map;
}

const toTemplateRow = (r: StoredTemplate, planNames: string[]): TemplateRowD1 => ({
  id: r.id,
  name: r.name,
  description: r.description,
  submission_format: r.submission_format,
  allowed_file_types: parseJson<string[]>(r.allowed_file_types, []),
  default_options: parseJson<Record<string, unknown>>(r.default_options, {}),
  due_offset_days: r.due_offset_days,
  importance: r.importance,
  is_required: Boolean(r.is_required),
  active: Boolean(r.active),
  planNames,
});

export async function listTemplatesD1(db: D1Database, actor: Actor, page = 1) {
  const venueId = requireAdminVenue(actor);
  const offset = (Math.max(page, 1) - 1) * LIST_PAGE_SIZE;
  const { results } = await db
    .prepare(
      'SELECT * FROM task_templates WHERE venue_id=? ORDER BY active DESC, due_offset_days DESC, name, id LIMIT ? OFFSET ?',
    )
    .bind(venueId, LIST_PAGE_SIZE + 1, offset)
    .all<StoredTemplate>();
  const names = await planNamesByTemplate(db, venueId);
  return {
    rows: results.slice(0, LIST_PAGE_SIZE).map((r) => toTemplateRow(r, names.get(r.id) ?? [])),
    hasNext: results.length > LIST_PAGE_SIZE,
  };
}

export async function getTemplateD1(db: D1Database, actor: Actor, templateId: string) {
  const venueId = requireAdminVenue(actor);
  const row = await db
    .prepare('SELECT * FROM task_templates WHERE id=? AND venue_id=?')
    .bind(templateId, venueId)
    .first<StoredTemplate>();
  return row
    ? toTemplateRow(row, (await planNamesByTemplate(db, venueId)).get(row.id) ?? [])
    : null;
}

/** プランの templates_json を正規化テーブルから再生成する (割当の実行時ソース)。 */
export async function rebuildPlanTemplatesJson(db: D1Database, planTypeId: string) {
  const { results } = await db
    .prepare(
      `SELECT tt.id,tt.name,tt.description,tt.submission_format,tt.allowed_file_types,tt.default_options,
              tt.due_offset_days,tt.importance,pt.display_order,pt.due_offset_days_override,pt.is_required
       FROM plan_task_templates pt JOIN task_templates tt ON tt.id=pt.task_template_id
       WHERE pt.plan_type_id=? AND tt.active=1 ORDER BY pt.display_order, tt.id`,
    )
    .bind(planTypeId)
    .all<{
      id: string;
      name: string;
      description: string | null;
      submission_format: string;
      allowed_file_types: string;
      default_options: string;
      due_offset_days: number;
      importance: string;
      display_order: number;
      due_offset_days_override: number | null;
      is_required: number;
    }>();
  const templates: TemplateForAssign[] = results.map((r) => ({
    taskTemplateId: r.id,
    title: r.name,
    description: r.description,
    submissionFormat: r.submission_format as TemplateForAssign['submissionFormat'],
    allowedFileTypes: parseJson<string[]>(r.allowed_file_types, []),
    options: parseJson<Record<string, unknown>>(r.default_options, {}),
    importance: r.importance as TemplateForAssign['importance'],
    dueOffsetDays: r.due_offset_days,
    dueOffsetDaysOverride: r.due_offset_days_override,
    isRequired: Boolean(r.is_required),
    displayOrder: r.display_order,
  }));
  await db
    .prepare('UPDATE plan_types SET templates_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(JSON.stringify(templates), planTypeId)
    .run();
  return templates.length;
}

async function rebuildPlansForTemplate(db: D1Database, templateId: string) {
  const { results } = await db
    .prepare('SELECT plan_type_id FROM plan_task_templates WHERE task_template_id=?')
    .bind(templateId)
    .all<{ plan_type_id: string }>();
  for (const r of results) await rebuildPlanTemplatesJson(db, r.plan_type_id);
}

export async function saveTemplateD1(
  db: D1Database,
  actor: Actor,
  templateId: string,
  input: z.infer<typeof taskTemplateSchema>,
): Promise<{ id: string }> {
  const venueId = requireAdminVenue(actor);
  const values = [
    input.name,
    input.description ?? null,
    input.submissionFormat,
    JSON.stringify(input.allowedFileTypes ?? []),
    JSON.stringify(input.defaultOptions ?? {}),
    input.dueOffsetDays,
    input.importance,
    input.isRequired ? 1 : 0,
    input.active ? 1 : 0,
  ];
  try {
    if (templateId === 'new') {
      const id = crypto.randomUUID();
      await db
        .prepare(
          'INSERT INTO task_templates(id,venue_id,name,description,submission_format,allowed_file_types,default_options,due_offset_days,importance,is_required,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(id, venueId, ...values)
        .run();
      return { id };
    }
    const r = await db
      .prepare(
        'UPDATE task_templates SET name=?,description=?,submission_format=?,allowed_file_types=?,default_options=?,due_offset_days=?,importance=?,is_required=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND venue_id=? RETURNING id',
      )
      .bind(...values, templateId, venueId)
      .first<{ id: string }>();
    if (!r) throw notFound();
    await rebuildPlansForTemplate(db, templateId);
    return { id: templateId };
  } catch (e) {
    if (isUniqueError(e)) throw conflict('同じ宿題名のテンプレートが既に登録されています');
    throw e;
  }
}

// ---------------------------------------------------------------- プラン種別 (T03)

export interface PlanTypeRowD1 {
  id: string;
  name: string;
  description: string | null;
  default_guest_count_min: number | null;
  default_guest_count_max: number | null;
  display_order: number;
  active: boolean;
}

export async function listPlanTypesD1(db: D1Database, actor: Actor, page = 1) {
  const venueId = requireAdminVenue(actor);
  const offset = (Math.max(page, 1) - 1) * LIST_PAGE_SIZE;
  const { results } = await db
    .prepare(
      'SELECT id,name,description,default_guest_count_min,default_guest_count_max,display_order,active FROM plan_types WHERE venue_id=? ORDER BY display_order,name,id LIMIT ? OFFSET ?',
    )
    .bind(venueId, LIST_PAGE_SIZE + 1, offset)
    .all<Omit<PlanTypeRowD1, 'active'> & { active: number }>();
  return {
    rows: results.slice(0, LIST_PAGE_SIZE).map((r) => ({ ...r, active: Boolean(r.active) })),
    hasNext: results.length > LIST_PAGE_SIZE,
  };
}

export async function getPlanTypeD1(db: D1Database, actor: Actor, planTypeId: string) {
  const venueId = requireAdminVenue(actor);
  const row = await db
    .prepare(
      'SELECT id,name,description,default_guest_count_min,default_guest_count_max,display_order,active FROM plan_types WHERE id=? AND venue_id=?',
    )
    .bind(planTypeId, venueId)
    .first<Omit<PlanTypeRowD1, 'active'> & { active: number }>();
  if (!row) return null;
  const { results: assignments } = await db
    .prepare(
      'SELECT task_template_id,display_order,due_offset_days_override,is_required FROM plan_task_templates WHERE plan_type_id=? ORDER BY display_order',
    )
    .bind(planTypeId)
    .all<{
      task_template_id: string;
      display_order: number;
      due_offset_days_override: number | null;
      is_required: number;
    }>();
  return {
    ...row,
    active: Boolean(row.active),
    assignments: assignments.map((a) => ({
      taskTemplateId: a.task_template_id,
      displayOrder: a.display_order,
      dueOffsetDaysOverride: a.due_offset_days_override,
      isRequired: Boolean(a.is_required),
    })),
  };
}

export async function listTemplateChoicesD1(db: D1Database, actor: Actor) {
  const venueId = requireAdminVenue(actor);
  const { results } = await db
    .prepare(
      'SELECT id,name,due_offset_days,active FROM task_templates WHERE venue_id=? ORDER BY active DESC, name, id',
    )
    .bind(venueId)
    .all<{ id: string; name: string; due_offset_days: number; active: number }>();
  return results.map((r) => ({ ...r, active: Boolean(r.active) }));
}

export async function savePlanTypeD1(
  db: D1Database,
  actor: Actor,
  planTypeId: string,
  input: z.infer<typeof planTypeSaveSchema>,
): Promise<{ id: string }> {
  const venueId = requireAdminVenue(actor);
  // 他式場のテンプレートは割り当てられない (Supabase 版の可視性チェックと同じ)
  for (const a of input.assignments) {
    const visible = await db
      .prepare('SELECT id FROM task_templates WHERE id=? AND venue_id=?')
      .bind(a.taskTemplateId, venueId)
      .first();
    if (!visible) throw conflict('選択できない宿題テンプレートが含まれています');
  }
  const dup = await db
    .prepare('SELECT id FROM plan_types WHERE venue_id=? AND name=? AND id<>?')
    .bind(venueId, input.name, planTypeId === 'new' ? '' : planTypeId)
    .first();
  if (dup) throw conflict('同じプラン種別名が既に登録されています');

  let savedId = planTypeId;
  if (planTypeId === 'new') {
    savedId = crypto.randomUUID();
    await db
      .prepare(
        'INSERT INTO plan_types(id,venue_id,name,description,default_guest_count_min,default_guest_count_max,display_order,active,templates_json) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        savedId,
        venueId,
        input.name,
        input.description ?? null,
        input.defaultGuestCountMin ?? 0,
        input.defaultGuestCountMax ?? null,
        input.displayOrder,
        input.active ? 1 : 0,
        '[]',
      )
      .run();
  } else {
    const r = await db
      .prepare(
        'UPDATE plan_types SET name=?,description=?,default_guest_count_min=?,default_guest_count_max=?,display_order=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND venue_id=? RETURNING id',
      )
      .bind(
        input.name,
        input.description ?? null,
        input.defaultGuestCountMin ?? 0,
        input.defaultGuestCountMax ?? null,
        input.displayOrder,
        input.active ? 1 : 0,
        planTypeId,
        venueId,
      )
      .first<{ id: string }>();
    if (!r) throw notFound();
  }

  // 割当は差分更新 (全消し→全入れにしない。Supabase 版と同じ方針)
  const { results: existing } = await db
    .prepare('SELECT task_template_id FROM plan_task_templates WHERE plan_type_id=?')
    .bind(savedId)
    .all<{ task_template_id: string }>();
  const keep = new Set(input.assignments.map((a) => a.taskTemplateId));
  const statements = existing
    .filter((r) => !keep.has(r.task_template_id))
    .map((r) =>
      db
        .prepare('DELETE FROM plan_task_templates WHERE plan_type_id=? AND task_template_id=?')
        .bind(savedId, r.task_template_id),
    );
  for (const a of input.assignments) {
    statements.push(
      db
        .prepare(
          `INSERT INTO plan_task_templates(plan_type_id,task_template_id,display_order,due_offset_days_override,is_required) VALUES (?,?,?,?,1)
           ON CONFLICT(plan_type_id,task_template_id) DO UPDATE SET display_order=excluded.display_order,due_offset_days_override=excluded.due_offset_days_override`,
        )
        .bind(savedId, a.taskTemplateId, a.displayOrder, a.dueOffsetDaysOverride ?? null),
    );
  }
  if (statements.length) await db.batch(statements);
  await rebuildPlanTemplatesJson(db, savedId);
  return { id: savedId };
}

// ---------------------------------------------------------------- S03 集計

export async function systemSummaryD1(db: D1Database, actor: Actor) {
  requireSystemAdmin(actor);
  const one = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const [venueCount, caseCount, userCount, batches, logs, usage, alerts] = await Promise.all([
    one('SELECT count(*) AS n FROM venues'),
    one('SELECT count(*) AS n FROM wedding_cases'),
    one("SELECT count(*) AS n FROM user_profiles WHERE status<>'deleted'"),
    listBatchRuns(db, undefined, 20),
    loadNotificationLogsForExportD1(db).catch(() => []),
    latestUsageSnapshot(db),
    listSystemAlerts(db, 50),
  ]);
  return {
    venueCount,
    caseCount,
    userCount,
    batches: batches.map((b) => ({
      id: b.id,
      job_type: b.job_type,
      started_at: b.started_at,
      finished_at: b.finished_at,
      target_count: b.target_count,
      http_status: b.http_status,
      error_message: b.error_message,
    })),
    logs: logs.slice(0, 50).map((l) => ({
      id: l.id,
      provider: l.provider,
      status: l.status,
      provider_message_id: l.provider_message_id,
      created_at: l.created_at,
      notifications: l.notifications
        ? {
            notification_type: l.notifications.notification_type as never,
            case_id: null,
            venues: l.notifications.venues,
            wedding_cases: l.notifications.wedding_cases,
          }
        : null,
    })),
    usage,
    alerts,
  };
}
