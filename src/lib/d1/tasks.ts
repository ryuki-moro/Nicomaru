import { randomUUID } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { AppUser } from '@/lib/auth/session';
import type { SubmissionFormat, TaskStatus, ReviewStatus, AllowedFileType } from '@/lib/constants';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { encryptPii, readPii } from '@/lib/crypto';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '@/lib/errors';
import {
  submitTaskSchema,
  reviewSubmissionSchema,
  caseTaskCreateSchema,
  caseTaskUpdateSchema,
} from '@/lib/validation';
import { phaseNameFor } from '@/lib/services/schedule';
import { scope } from './cases';
import type { z } from 'zod';

type Actor = Pick<AppUser, 'id'>;
export interface TaskRow {
  id: string;
  case_id: string;
  title: string;
  description: string | null;
  due_date: string;
  status: TaskStatus;
  submission_format: SubmissionFormat;
  options: Record<string, unknown> | null;
  allowed_file_types: AllowedFileType[];
  version: number;
}
type StoredTask = Omit<TaskRow, 'options' | 'allowed_file_types'> & {
  options: string | null;
  allowed_file_types: string;
};
interface Submission {
  id: string;
  case_task_id: string;
  submitted_by: string;
  submission_type: SubmissionFormat;
  text_value: string | null;
  selected_value: string | null;
  file_id: string | null;
  comment: string | null;
  review_status: ReviewStatus;
  planner_feedback: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  is_latest: number;
  task_version: number;
}
function decodeTask(row: StoredTask): TaskRow {
  return {
    ...row,
    options: row.options ? JSON.parse(row.options) : null,
    allowed_file_types: JSON.parse(row.allowed_file_types),
  };
}
export async function taskRole(db: D1Database, user: Actor, couple: boolean) {
  const row = await db
    .prepare("SELECT role FROM user_profiles WHERE id=? AND status='active'")
    .bind(user.id)
    .first<{ role: string }>();
  if (
    !row ||
    (couple ? row.role !== 'couple' : !['planner', 'admin', 'system_admin'].includes(row.role))
  )
    throw forbidden();
}
const staffRole = `EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.status='active' AND r.role IN ('planner','admin','system_admin'))`;
const access = `EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=case_id AND c.archived_at IS NULL AND ${scope})`;
export async function taskRow(db: D1Database, user: Actor, id: string) {
  const row = await db
    .prepare(`SELECT * FROM case_tasks WHERE id=? AND ${access}`)
    .bind(id, user.id)
    .first<StoredTask>();
  if (!row) throw notFound();
  return decodeTask(row);
}
export async function taskList(
  db: D1Database,
  user: Actor,
  statuses: readonly string[],
  offset: number,
) {
  await taskRole(db, user, true);
  return (
    await db
      .prepare(
        `SELECT * FROM case_tasks WHERE status IN (${statuses.map(() => '?').join(',')}) AND ${access} AND EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.role='couple' AND r.status='active') ORDER BY due_date,display_order,id LIMIT ? OFFSET ?`,
      )
      .bind(...statuses, user.id, user.id, LIST_PAGE_SIZE + 1, offset)
      .all<StoredTask>()
  ).results.map(decodeTask);
}
export async function latestSubmission(db: D1Database, user: Actor, id: string) {
  await taskRow(db, user, id);
  const row = await db
    .prepare(
      `SELECT s.* FROM task_submissions s JOIN case_tasks t ON t.id=s.case_task_id WHERE s.case_task_id=? AND s.is_latest=1 AND ${access} AND (s.review_status<>'draft' OR s.submitted_by=?)`,
    )
    .bind(id, user.id, user.id)
    .first<Submission>();
  return row
    ? { ...row, comment: readPii(row.comment), planner_feedback: readPii(row.planner_feedback) }
    : null;
}
// 全文の書込みを同じtask.versionとDB現在値で囲み、最後のversion更新までbatchで原子的に行う。
function guard(task: TaskRow, user: Actor, couple: boolean) {
  return {
    sql: `EXISTS(SELECT 1 FROM case_tasks t JOIN wedding_cases c ON c.id=t.case_id JOIN user_profiles actor ON actor.id=? WHERE t.id=? AND t.version=? AND c.archived_at IS NULL AND actor.status='active' AND ${couple ? "actor.role='couple'" : "actor.role IN ('planner','admin','system_admin')"} AND ${scope})`,
    args: [user.id, task.id, task.version, user.id],
  };
}
async function commit(
  db: D1Database,
  user: Actor,
  task: TaskRow,
  couple: boolean,
  statements: ReturnType<D1Database['prepare']>[],
  status?: string,
) {
  const g = guard(task, user, couple);
  statements.push(
    db
      .prepare(`UPDATE wedding_cases SET version=version+1 WHERE id=? AND ${g.sql}`)
      .bind(task.case_id, ...g.args),
  );
  statements.push(
    db
      .prepare(
        `UPDATE case_tasks SET version=version+1${status ? ',status=?,confirmed_by=?,confirmed_at=?' : ''} WHERE id=? AND ${g.sql}`,
      )
      .bind(
        ...(status
          ? [
              status,
              status === 'confirmed' ? user.id : null,
              status === 'confirmed' ? new Date().toISOString() : null,
            ]
          : []),
        task.id,
        ...g.args,
      ),
  );
  const results = await db.batch(statements);
  if (!results.at(-1)?.meta.changes)
    throw conflict('宿題の内容が更新されました。開き直してください');
}
export async function submitTask(
  db: D1Database,
  user: Actor,
  id: string,
  raw: z.input<typeof submitTaskSchema>,
) {
  await taskRole(db, user, true);
  const input = submitTaskSchema.safeParse(raw);
  if (!input.success)
    throw badRequest(
      input.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  const body = input.data,
    task = await taskRow(db, user, id);
  if (task.status === 'waived') throw unprocessable('この宿題は対応不要です');
  if (body.submissionType !== task.submission_format) throw conflict('提出形式が更新されています');
  if (body.draft && task.submission_format === 'none')
    throw badRequest([{ field: 'draft', reason: '確認のみの宿題は一時保存できません' }]);
  const text = task.submission_format === 'text' ? body.textValue?.trim() || null : null;
  const selected = task.submission_format === 'select' ? body.selectedValue?.trim() || null : null;
  const file = task.submission_format === 'file' ? (body.fileId ?? null) : null;
  if (
    !body.draft &&
    ((task.submission_format === 'text' && !text) ||
      (task.submission_format === 'select' && !selected) ||
      (task.submission_format === 'file' && !file))
  )
    throw badRequest([
      {
        field:
          task.submission_format === 'text'
            ? 'textValue'
            : task.submission_format === 'select'
              ? 'selectedValue'
              : 'fileId',
        reason: '回答を入力してください',
      },
    ]);
  if (
    selected &&
    (!Array.isArray(task.options?.choices) || !task.options.choices.includes(selected))
  )
    throw badRequest([{ field: 'selectedValue', reason: '選択肢から選んでください' }]);
  if (
    file &&
    !(await db
      .prepare('SELECT id FROM storage_files WHERE id=? AND case_id=? AND task_id=?')
      .bind(file, task.case_id, task.id)
      .first())
  )
    throw badRequest([{ field: 'fileId', reason: '添付ファイルを確認できません' }]);
  const latest = await db
    .prepare('SELECT * FROM task_submissions WHERE case_task_id=? AND is_latest=1')
    .bind(id)
    .first<Submission>();
  if (body.draft && latest?.review_status === 'submitted')
    throw unprocessable('提出済みの内容は一時保存に戻せません');
  const overwrite = latest && ['draft', 'submitted'].includes(latest.review_status);
  const submissionId = overwrite ? latest.id : randomUUID();
  const status = body.draft ? 'draft' : 'submitted',
    g = guard(task, user, true);
  const statements = [];
  if (!overwrite && latest)
    statements.push(
      db
        .prepare(`UPDATE task_submissions SET is_latest=0 WHERE id=? AND ${g.sql}`)
        .bind(latest.id, ...g.args),
    );
  const values = [
    user.id,
    task.submission_format,
    encryptPii(text),
    selected,
    file,
    encryptPii(body.comment?.trim() || null),
    status,
    new Date().toISOString(),
  ];
  if (overwrite)
    statements.push(
      db
        .prepare(
          `UPDATE task_submissions SET submitted_by=?,submission_type=?,text_value=?,selected_value=?,file_id=?,comment=?,review_status=?,submitted_at=? WHERE id=? AND ${g.sql}`,
        )
        .bind(...values, submissionId, ...g.args),
    );
  else
    statements.push(
      db
        .prepare(
          `INSERT INTO task_submissions(id,case_task_id,submitted_by,submission_type,text_value,selected_value,file_id,comment,review_status,submitted_at,is_latest) SELECT ?,?,?,?,?,?,?,?,?,?,1 WHERE ${g.sql}`,
        )
        .bind(submissionId, id, ...values, ...g.args),
    );
  statements.push(
    db
      .prepare(`INSERT INTO case_audit(case_id,actor_id,action) SELECT ?,?,? WHERE ${g.sql}`)
      .bind(task.case_id, user.id, body.draft ? 'task_draft' : 'task_submit', ...g.args),
  );
  await commit(db, user, task, true, statements, body.draft ? undefined : 'submitted');
  return { id: submissionId, reviewStatus: status };
}
export async function submissionRow(db: D1Database, user: Actor, id: string) {
  await taskRole(db, user, false);
  const row = await db
    .prepare(
      `SELECT s.*,t.version AS task_version FROM task_submissions s JOIN case_tasks t ON t.id=s.case_task_id WHERE s.id=? AND s.review_status<>'draft' AND ${access} AND ${staffRole}`,
    )
    .bind(id, user.id, user.id)
    .first<Submission>();
  if (!row) throw notFound();
  const task = await taskRow(db, user, row.case_task_id);
  const c = await db
    .prepare('SELECT id,case_code,wedding_date FROM wedding_cases WHERE id=?')
    .bind(task.case_id)
    .first<{ id: string; case_code: string; wedding_date: string }>();
  return {
    ...row,
    comment: readPii(row.comment),
    planner_feedback: readPii(row.planner_feedback),
    content_json: null,
    case_tasks: { ...task, wedding_cases: c! },
    storage_files: row.file_id
      ? await db
          .prepare('SELECT * FROM storage_files WHERE id=? AND case_id=?')
          .bind(row.file_id, task.case_id)
          .first<{
            id: string;
            object_path: string;
            original_filename: string;
            mime_type: string;
            file_size_bytes: number;
          }>()
          .then((f) => (f ? { ...f, bucket: 'case-files' } : null))
      : null,
  };
}
export async function reviewSubmission(
  db: D1Database,
  user: Actor,
  id: string,
  raw: z.input<typeof reviewSubmissionSchema>,
) {
  await taskRole(db, user, false);
  const parsed = reviewSubmissionSchema.safeParse(raw);
  if (!parsed.success)
    throw badRequest(
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  const input = parsed.data,
    row = await submissionRow(db, user, id),
    task = row.case_tasks;
  if (row.task_version !== task.version || !row.is_latest || row.review_status !== 'submitted')
    throw conflict('この提出は確認できる状態ではありません');
  if (task.status === 'waived') throw unprocessable('この宿題は対応不要です');
  const g = guard(task, user, false);
  await commit(
    db,
    user,
    task,
    false,
    [
      db
        .prepare(
          `UPDATE task_submissions SET review_status=?,planner_feedback=?,reviewed_by=?,reviewed_at=? WHERE id=? AND is_latest=1 AND review_status='submitted' AND ${g.sql}`,
        )
        .bind(
          input.decision,
          encryptPii(input.comment ?? null),
          user.id,
          new Date().toISOString(),
          id,
          ...g.args,
        ),
      db
        .prepare(`INSERT INTO case_audit(case_id,actor_id,action) SELECT ?,?,? WHERE ${g.sql}`)
        .bind(task.case_id, user.id, 'task_' + input.decision, ...g.args),
    ],
    input.decision,
  );
  return { id, caseId: task.case_id, caseTaskId: task.id, reviewStatus: input.decision };
}
export async function pendingSubmissions(db: D1Database, user: Actor, offset: number) {
  await taskRole(db, user, false);
  const where = `s.review_status='submitted' AND s.is_latest=1 AND t.status<>'waived' AND ${access}`;
  const total = await db
    .prepare(
      `SELECT COUNT(*) n FROM task_submissions s JOIN case_tasks t ON t.id=s.case_task_id WHERE ${where}`,
    )
    .bind(user.id)
    .first<{ n: number }>();
  const ids = await db
    .prepare(
      `SELECT s.id FROM task_submissions s JOIN case_tasks t ON t.id=s.case_task_id WHERE ${where} ORDER BY s.submitted_at,s.id LIMIT ? OFFSET ?`,
    )
    .bind(user.id, LIST_PAGE_SIZE, offset)
    .all<{ id: string }>();
  return {
    data: await Promise.all(ids.results.map((r) => submissionRow(db, user, r.id))),
    count: total!.n,
    error: null,
  };
}
export async function coupleNames(db: D1Database, user: Actor, caseIds: string[]) {
  if (!caseIds.length) return [];
  return (
    await db
      .prepare(
        `SELECT cp.* FROM couple_profiles cp JOIN wedding_cases c ON c.id=cp.case_id WHERE c.id IN (${caseIds.map(() => '?').join(',')}) AND ${scope}`,
      )
      .bind(...caseIds, user.id)
      .all<{
        case_id: string;
        partner_role: string;
        full_name: string;
        is_primary_contact: boolean;
      }>()
  ).results;
}
export async function addTask(
  db: D1Database,
  user: Actor,
  caseId: string,
  input: z.infer<typeof caseTaskCreateSchema>,
) {
  await taskRole(db, user, false);
  const c = await db
    .prepare(
      `SELECT c.wedding_date FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope}`,
    )
    .bind(caseId, user.id)
    .first<{ wedding_date: string }>();
  if (!c) throw notFound();
  const id = randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO case_tasks(id,case_id,title,description,submission_format,allowed_file_types,options,is_required,importance,due_date,phase_name,display_order) SELECT ?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(display_order)+1 FROM case_tasks WHERE case_id=?),0) WHERE EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope} AND EXISTS(SELECT 1 FROM user_profiles WHERE id=? AND status='active' AND role IN ('planner','admin','system_admin')))`,
    )
    .bind(
      id,
      caseId,
      input.title,
      input.description ?? null,
      input.submissionFormat,
      JSON.stringify(input.allowedFileTypes),
      JSON.stringify(input.options ?? null),
      Number(input.isRequired),
      input.importance,
      input.dueDate,
      phaseNameFor(c.wedding_date, input.dueDate),
      caseId,
      caseId,
      user.id,
      user.id,
    )
    .run();
  if (!result.meta.changes) throw notFound();
  return {
    id,
    displayOrder: (await db
      .prepare('SELECT display_order FROM case_tasks WHERE id=?')
      .bind(id)
      .first<{ display_order: number }>())!.display_order,
  };
}
export async function updateTask(
  db: D1Database,
  user: Actor,
  caseId: string,
  id: string,
  input: z.infer<typeof caseTaskUpdateSchema>,
) {
  await taskRole(db, user, false);
  const task = await taskRow(db, user, id);
  if (task.case_id !== caseId) throw notFound();
  if (!Object.keys(input).length)
    throw badRequest([{ field: '_', reason: '変更する項目がありません' }]);
  if (input.waived !== undefined && !['not_started', 'waived'].includes(task.status))
    throw unprocessable('提出済みの宿題は対応不要に変更できません');
  const g = guard(task, user, false),
    columns: string[] = [],
    values: (string | null)[] = [];
  for (const [key, value] of Object.entries({
    title: input.title,
    description: input.description,
    due_date: input.dueDate,
  }))
    if (value !== undefined) {
      columns.push(`${key}=?`);
      values.push(value);
    }
  if (input.dueDate) {
    const c = await db
      .prepare('SELECT wedding_date FROM wedding_cases WHERE id=?')
      .bind(caseId)
      .first<{ wedding_date: string }>();
    columns.push('phase_name=?');
    values.push(phaseNameFor(c!.wedding_date, input.dueDate));
  }
  if (input.waived !== undefined) {
    columns.push('status=?');
    values.push(input.waived ? 'waived' : 'not_started');
  }
  await commit(db, user, task, false, [
    db
      .prepare(`UPDATE case_tasks SET ${columns.join(',')} WHERE id=? AND ${g.sql}`)
      .bind(...values, id, ...g.args),
  ]);
}
