import type { D1Database } from '@cloudflare/workers-types';
import type { AppUser } from '@/lib/auth/session';
import type {
  CaseStatus,
  ContactChannel,
  PartnerRole,
  TaskStatus,
  Importance,
  SubmissionFormat,
} from '@/lib/constants';
import type { CaseListItem } from '@/lib/services/cases';
import { encryptPii, readPii } from '@/lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import {
  planTasks,
  previewPlanChange,
  recalculateDueDates,
  phaseNameFor,
  type TemplateForAssign,
} from '@/lib/services/schedule';
import type { z } from 'zod';
import type { casePatchSchema } from '@/lib/validation';

// 全ての参照・更新で同じ条件を使い、ロール・所属・停止状態はDBの現在値を読む。
export const scope = `EXISTS (SELECT 1 FROM user_profiles a WHERE a.id=? AND a.status='active' AND (
  a.role='system_admin' OR (a.venue_id=c.venue_id AND (
    a.role='admin' OR (a.role='planner' AND c.primary_planner_id=a.id AND c.archived_at IS NULL)
    OR (a.role='couple' AND c.archived_at IS NULL AND EXISTS (SELECT 1 FROM couple_profiles cp WHERE cp.case_id=c.id AND cp.user_id=a.id))
  ))) )`;
interface Profile {
  partner_role: PartnerRole;
  full_name: string;
  email: string | null;
  is_primary_contact: boolean;
}
interface Task {
  id: string;
  task_template_id: string | null;
  title: string;
  due_date: string;
  due_offset_days: number | null;
  status: TaskStatus;
  importance: Importance;
  display_order: number;
  submission_format: SubmissionFormat;
}
export interface D1Case {
  id: string;
  venue_id: string;
  primary_planner_id: string;
  plan_type_id: string | null;
  case_code: string;
  wedding_date: string;
  wedding_time: string | null;
  contact_channel: ContactChannel;
  status: CaseStatus;
  guest_count: number | null;
  venue_room: string | null;
  notes: string | null;
  archived_at: string | null;
  version: number;
  plan_types: { id: string; name: string } | null;
  user_profiles: { id: string; display_name: string } | null;
  couple_profiles: Profile[];
  case_tasks: Task[];
  risk_score_snapshots: [];
}
export async function caseRow(db: D1Database, user: AppUser, id: string): Promise<D1Case> {
  const row = await db
    .prepare(`SELECT c.* FROM wedding_cases c WHERE c.id=? AND ${scope}`)
    .bind(id, user.id)
    .first<
      Omit<
        D1Case,
        'plan_types' | 'user_profiles' | 'couple_profiles' | 'case_tasks' | 'risk_score_snapshots'
      >
    >();
  if (!row) throw notFound();
  const [profiles, tasks, plan, planner] = await Promise.all([
    db
      .prepare(
        `SELECT partner_role,full_name,email,is_primary_contact FROM couple_profiles WHERE case_id=? AND EXISTS (SELECT 1 FROM wedding_cases c WHERE c.id=case_id AND ${scope})`,
      )
      .bind(id, user.id)
      .all<Profile>(),
    db
      .prepare(
        `SELECT * FROM case_tasks WHERE case_id=? AND EXISTS (SELECT 1 FROM wedding_cases c WHERE c.id=case_id AND ${scope}) ORDER BY due_date,display_order,id`,
      )
      .bind(id, user.id)
      .all<Task>(),
    db
      .prepare('SELECT id,name FROM plan_types WHERE id=? AND venue_id=?')
      .bind(row.plan_type_id, row.venue_id)
      .first<{ id: string; name: string }>(),
    db
      .prepare('SELECT u.id,u.name AS display_name FROM "user" u WHERE id=?')
      .bind(row.primary_planner_id)
      .first<{ id: string; display_name: string }>(),
  ]);
  return {
    ...row,
    notes: user.role === 'couple' ? null : row.notes,
    couple_profiles: profiles.results.map((p) => ({
      ...p,
      full_name: readPii(p.full_name),
      email: p.email === null ? null : readPii(p.email),
      is_primary_contact: Boolean(p.is_primary_contact),
    })),
    case_tasks: tasks.results,
    plan_types: plan,
    user_profiles: planner,
    risk_score_snapshots: [],
  };
}
export async function listCases(
  db: D1Database,
  user: AppUser,
  options: {
    scope?: string;
    sort?: string;
    keyword?: string | null;
    offset?: number;
    limit?: number;
  } = {},
) {
  const archived = options.scope === 'archived';
  const found = await db
    .prepare(
      `SELECT c.id,c.case_code,c.wedding_date,c.status,p.name AS plan_name,
    (SELECT json_group_array(json_object('partnerRole',cp.partner_role,'fullName',cp.full_name)) FROM couple_profiles cp WHERE cp.case_id=c.id) AS partners_json,
    (SELECT count(*) FROM case_tasks t WHERE t.case_id=c.id) AS task_total,
    (SELECT count(*) FROM case_tasks t WHERE t.case_id=c.id AND t.status IN ('confirmed','waived')) AS task_done
    FROM wedding_cases c LEFT JOIN plan_types p ON p.id=c.plan_type_id AND p.venue_id=c.venue_id
    WHERE ${scope} AND c.archived_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY c.wedding_date,c.id LIMIT 501`,
    )
    .bind(user.id)
    .all<{
      id: string;
      case_code: string;
      wedding_date: string;
      status: CaseStatus;
      plan_name: string | null;
      partners_json: string;
      task_total: number;
      task_done: number;
    }>();
  const keyword = (options.keyword ?? '').toLowerCase();
  const items: CaseListItem[] = found.results
    .slice(0, 500)
    .map((row) => {
      const partners = (
        JSON.parse(row.partners_json) as { partnerRole: PartnerRole; fullName: string }[]
      ).map((p) => ({ ...p, fullName: readPii(p.fullName) }));
      return {
        id: row.id,
        caseCode: row.case_code,
        weddingDate: row.wedding_date,
        status: row.status,
        planTypeName: row.plan_name ?? '未設定',
        coupleName: partners.map((p) => p.fullName).join(' / '),
        partners,
        total: row.task_total,
        done: row.task_done,
        risk: null,
      };
    })
    .filter((r) => !keyword || `${r.caseCode} ${r.coupleName}`.toLowerCase().includes(keyword));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 50)));
  return {
    items: items.slice(offset, offset + limit),
    hasNext: items.length > offset + limit,
    truncated: found.results.length > 500,
  };
}
export function detailDto(row: D1Case) {
  return {
    id: row.id,
    caseCode: row.case_code,
    weddingDate: row.wedding_date,
    weddingTime: row.wedding_time,
    contactChannel: row.contact_channel,
    status: row.status,
    guestCount: row.guest_count,
    venueRoom: row.venue_room,
    notes: row.notes,
    archivedAt: row.archived_at,
    planType: row.plan_types,
    primaryPlanner: row.user_profiles,
    partners: row.couple_profiles.map((p) => ({
      partnerRole: p.partner_role,
      fullName: p.full_name,
      email: p.email,
      isPrimaryContact: p.is_primary_contact,
    })),
    taskTotal: row.case_tasks.length,
    taskDone: row.case_tasks.filter((t) => ['confirmed', 'waived'].includes(t.status)).length,
  };
}
export async function patchCase(
  db: D1Database,
  user: AppUser,
  id: string,
  input: z.infer<typeof casePatchSchema>,
) {
  if (user.role === 'couple') throw forbidden();
  const row = await caseRow(db, user, id);
  if (input.weddingTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.weddingTime))
    throw badRequest([{ field: 'weddingTime', reason: '有効な時刻を指定してください' }]);
  const admin = user.role === 'admin' || user.role === 'system_admin';
  if ((input.primaryPlannerId !== undefined || input.archived !== undefined) && !admin)
    throw forbidden();
  if (
    input.archived !== undefined &&
    Object.keys(input).some((k) => !['archived', 'confirmed'].includes(k))
  )
    throw badRequest();
  if (row.archived_at && input.archived === undefined)
    throw conflict('アーカイブ済み案件は復元してから編集してください');
  if (input.primaryPlannerId !== undefined) {
    const planner = await db
      .prepare(
        "SELECT id FROM user_profiles WHERE id=? AND venue_id=? AND role='planner' AND status='active'",
      )
      .bind(input.primaryPlannerId, row.venue_id)
      .first();
    if (!planner)
      throw badRequest([
        { field: 'primaryPlannerId', reason: '所属式場の有効なプランナーを指定してください' },
      ]);
  }
  const planId = input.planTypeId ?? row.plan_type_id;
  const plan = planId
    ? await db
        .prepare('SELECT templates_json FROM plan_types WHERE id=? AND venue_id=? AND active=1')
        .bind(planId, row.venue_id)
        .first<{ templates_json: string }>()
    : null;
  if (input.planTypeId !== undefined && !plan)
    throw badRequest([{ field: 'planTypeId', reason: '所属式場のプランを指定してください' }]);
  const date = input.weddingDate ?? row.wedding_date;
  const existing = row.case_tasks.map((t) => ({
    id: t.id,
    taskTemplateId: t.task_template_id,
    title: t.title,
    status: t.status,
    dueDate: t.due_date,
    dueOffsetDays: t.due_offset_days,
  }));
  const changedPlan = input.planTypeId !== undefined && planId !== row.plan_type_id;
  const templates: TemplateForAssign[] = plan ? JSON.parse(plan.templates_json) : [];
  const changes = changedPlan
    ? previewPlanChange(date, existing, templates)
    : { waived: [], added: [] };
  const waived = new Set(changes.waived.map((t) => t.id));
  const dueChanges =
    date !== row.wedding_date
      ? recalculateDueDates(
          date,
          existing.filter((t) => !waived.has(t.id)),
        )
      : [];
  if ((changedPlan || date !== row.wedding_date) && !input.confirmed)
    return {
      applied: false,
      preview: {
        weddingDate: date,
        planChanged: changedPlan,
        dueChanges,
        waived: changes.waived,
        added: changes.added,
      },
    };
  const writeRoles =
    input.primaryPlannerId !== undefined || input.archived !== undefined
      ? "'admin','system_admin'"
      : "'planner','admin','system_admin'";
  const args = [id, row.version, user.id, user.id];
  let references = '';
  if (input.primaryPlannerId !== undefined) {
    references +=
      " AND EXISTS (SELECT 1 FROM user_profiles target WHERE target.id=? AND target.venue_id=c.venue_id AND target.role='planner' AND target.status='active')";
    args.push(input.primaryPlannerId);
  }
  if (input.planTypeId !== undefined) {
    references +=
      ' AND EXISTS (SELECT 1 FROM plan_types target WHERE target.id=? AND target.venue_id=c.venue_id AND target.active=1)';
    args.push(input.planTypeId);
  }
  const guard = `EXISTS (SELECT 1 FROM wedding_cases c WHERE c.id=? AND c.version=? AND ${scope} AND EXISTS (SELECT 1 FROM user_profiles w WHERE w.id=? AND w.status='active' AND w.role IN (${writeRoles}))${references})`;
  const statements = [];
  const fields: Record<string, unknown> = {};
  for (const [key, col] of Object.entries({
    weddingDate: 'wedding_date',
    weddingTime: 'wedding_time',
    contactChannel: 'contact_channel',
    guestCount: 'guest_count',
    venueRoom: 'venue_room',
    notes: 'notes',
    planTypeId: 'plan_type_id',
    primaryPlannerId: 'primary_planner_id',
  })) {
    const value = input[key as keyof typeof input];
    if (value !== undefined) fields[col] = value;
  }
  if (input.archived !== undefined) {
    fields.archived_at = input.archived ? new Date().toISOString() : null;
    fields.status = input.archived ? 'archived' : 'active';
  }
  for (const partner of ['groom', 'bride'] as const) {
    const name = partner === 'groom' ? input.groomName : input.brideName;
    if (name !== undefined)
      statements.push(
        db
          .prepare(
            `UPDATE couple_profiles SET full_name=? WHERE case_id=? AND partner_role=? AND ${guard}`,
          )
          .bind(encryptPii(name), id, partner, ...args),
      );
  }
  if (input.primaryContact !== undefined)
    statements.push(
      db
        .prepare(
          `UPDATE couple_profiles SET is_primary_contact=(partner_role=?) WHERE case_id=? AND ${guard}`,
        )
        .bind(input.primaryContact, id, ...args),
    );
  if (input.contactEmail !== undefined)
    statements.push(
      db
        .prepare(
          `UPDATE couple_profiles SET email=? WHERE case_id=? AND is_primary_contact=1 AND ${guard}`,
        )
        .bind(encryptPii(input.contactEmail), id, ...args),
    );
  for (const change of dueChanges)
    statements.push(
      db
        .prepare(
          `UPDATE case_tasks SET due_date=?,phase_name=?,version=version+1 WHERE id=? AND case_id=? AND ${guard}`,
        )
        .bind(change.to, phaseNameFor(date, change.to), change.id, id, ...args),
    );
  for (const task of changes.waived)
    statements.push(
      db
        .prepare(
          `UPDATE case_tasks SET status='waived',version=version+1 WHERE id=? AND case_id=? AND ${guard}`,
        )
        .bind(task.id, id, ...args),
    );
  const newTasks = changedPlan
    ? planTasks(
        date,
        templates,
        existing.map((t) => t.taskTemplateId).filter((v): v is string => v !== null),
      )
    : [];
  for (const task of newTasks) {
    const template = templates.find((t) => t.taskTemplateId === task.taskTemplateId)!;
    statements.push(
      db
        .prepare(
          `INSERT INTO case_tasks(id,case_id,task_template_id,title,due_date,due_offset_days,status,importance,display_order,submission_format,phase_name,description,options,allowed_file_types,is_required) SELECT ?,?,?,?,?,?,'not_started',?,?,?,?,?,?,?,? WHERE ${guard}`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          task.taskTemplateId,
          task.title,
          task.dueDate,
          template.dueOffsetDaysOverride ?? template.dueOffsetDays,
          task.importance,
          task.displayOrder,
          task.submissionFormat,
          phaseNameFor(date, task.dueDate),
          task.description,
          JSON.stringify(task.options),
          JSON.stringify(task.allowedFileTypes),
          Number(task.isRequired),
          ...args,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO case_audit(case_id,actor_id,action) SELECT ?,?,'case.update' WHERE ${guard}`,
      )
      .bind(id, user.id, ...args),
  );
  statements.push(
    db
      .prepare(
        `UPDATE wedding_cases AS c SET ${Object.keys(fields)
          .map((k) => `${k}=?`)
          .concat(['version=version+1', 'updated_at=CURRENT_TIMESTAMP'])
          .join(
            ',',
          )} WHERE c.id=? AND c.version=? AND ${scope} AND EXISTS (SELECT 1 FROM user_profiles w WHERE w.id=? AND w.status='active' AND w.role IN (${writeRoles}))${references} RETURNING id`,
      )
      .bind(...(Object.values(fields) as (string | number | null)[]), ...args),
  );
  const results = await db.batch(statements);
  if (!results[results.length - 1].results.length) throw conflict();
  return {
    applied: true,
    dueChanged: dueChanges.length,
    waived: changes.waived.length,
    added: newTasks.length,
  };
}
