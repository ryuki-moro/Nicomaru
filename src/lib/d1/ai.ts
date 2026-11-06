import { randomUUID } from 'node:crypto';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { checkCsvText, csvSchemaOf, looksLikeCsv } from '@/lib/ai/submissionCheck';
import type { AppUser } from '@/lib/auth/session';
import { AI_JOB_TYPES, validateAiOutput, type AiJobInput, type AiJobType } from '@/lib/ai/schemas';
import type { AiAssistStatus, AiJobRow, AiJobStatus } from '@/lib/ai/assist';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { encryptPii, readPii } from '@/lib/crypto';
import { badRequest, conflict, notFound, unprocessable } from '@/lib/errors';
import { scope } from './cases';
import { taskRole, taskRow } from './tasks';

type Actor = Pick<AppUser, 'id'>;
/** 7-3 (4)「最終ポーリングから10分以上経過」で利用不可。 */
const ALIVE_MS = 10 * 60_000;
/** 7-3「locked_at が30分を超えた processing は queued へ戻し、上限3回で failed」。 */
const STALE_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

interface StoredJob {
  id: string;
  case_id: string;
  related_task_id: string | null;
  job_type: AiJobType;
  status: AiJobStatus;
  input_ref: string;
  output: string | null;
  reviewed_output: string | null;
  error_message: string | null;
  model_name: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// 入出力は利用者の自由記述を含むため、他のPII列と同じく暗号化して保存する（13-1）。
const seal = (value: unknown) => (value == null ? null : encryptPii(JSON.stringify(value)));
// 壊れた行1件で一覧や画面全体を落とさない（出力が無い扱いにする）。
function open(stored: string | null) {
  if (stored == null) return null;
  try {
    return JSON.parse(readPii(stored));
  } catch {
    return null;
  }
}

function view(row: StoredJob): AiJobRow & { model_name: string | null; started_at: string | null } {
  return {
    id: row.id,
    case_id: row.case_id,
    related_task_id: row.related_task_id,
    job_type: row.job_type,
    status: row.status,
    output: open(row.output),
    reviewed_output: open(row.reviewed_output),
    error_message: row.error_message,
    created_at: row.created_at,
    finished_at: row.finished_at,
    model_name: row.model_name,
    started_at: row.started_at,
  };
}

const staffCase = `EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=j.case_id AND c.archived_at IS NULL AND ${scope}) AND EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.status='active' AND r.role IN ('planner','admin','system_admin'))`;

export async function aiAssistStatus(db: D1Database): Promise<AiAssistStatus> {
  const row = await db
    .prepare('SELECT MAX(last_seen_at) AS last FROM ai_worker_heartbeats')
    .first<{ last: string | null }>();
  const last = row?.last ?? null;
  return { available: last !== null && Date.parse(last) > Date.now() - ALIVE_MS, lastSeenAt: last };
}

export async function jobRow(db: D1Database, user: Actor, id: string) {
  const row = await db
    .prepare(`SELECT j.* FROM ai_jobs j WHERE j.id=? AND ${staffCase}`)
    .bind(id, user.id, user.id)
    .first<StoredJob>();
  if (!row) throw notFound('ジョブが見つかりません');
  return view(row);
}

export async function latestJobForTask(
  db: D1Database,
  user: Actor,
  taskId: string,
  jobType: AiJobType,
) {
  const row = await db
    .prepare(
      `SELECT j.* FROM ai_jobs j WHERE j.related_task_id=? AND j.job_type=? AND j.status<>'discarded' AND ${staffCase} ORDER BY j.created_at DESC LIMIT 1`,
    )
    .bind(taskId, jobType, user.id, user.id)
    .first<StoredJob>();
  return row ? view(row) : null;
}

/** 案件に紐づく最新ジョブ（D03シート下書き・D05起票案。いずれも related_task_id を持たない）。 */
export async function latestJobForCase(
  db: D1Database,
  user: Actor,
  caseId: string,
  jobType: AiJobType,
) {
  const row = await db
    .prepare(
      `SELECT j.* FROM ai_jobs j WHERE j.case_id=? AND j.job_type=? AND j.related_task_id IS NULL AND j.status<>'discarded' AND ${staffCase} ORDER BY j.created_at DESC LIMIT 1`,
    )
    .bind(caseId, jobType, user.id, user.id)
    .first<StoredJob>();
  return row ? view(row) : null;
}

export async function jobList(db: D1Database, user: Actor, caseId?: string, jobType?: string) {
  const type = (AI_JOB_TYPES as readonly string[]).includes(jobType ?? '') ? jobType : null;
  const rows = await db
    .prepare(
      `SELECT j.* FROM ai_jobs j WHERE (? IS NULL OR j.case_id=?) AND (? IS NULL OR j.job_type=?) AND ${staffCase} ORDER BY j.created_at DESC LIMIT ?`,
    )
    .bind(
      caseId ?? null,
      caseId ?? null,
      type ?? null,
      type ?? null,
      user.id,
      user.id,
      LIST_PAGE_SIZE,
    )
    .all<StoredJob>();
  return rows.results.map(view);
}

async function insertJob(
  db: D1Database,
  caseId: string,
  taskId: string | null,
  jobType: AiJobType,
  input: AiJobInput,
) {
  const id = randomUUID(),
    now = new Date().toISOString();
  // venue_id は案件から引く。引数で受け取ると他式場のジョブを作れてしまう。
  const result = await db
    .prepare(
      `INSERT INTO ai_jobs(id,venue_id,case_id,related_task_id,job_type,input_ref,status,created_at,updated_at) SELECT ?,venue_id,id,?,?,?,'queued',?,? FROM wedding_cases WHERE id=?`,
    )
    .bind(id, taskId, jobType, seal(input), now, now, caseId)
    .run();
  if (!result.meta.changes) throw notFound();
  return id;
}

/** プランナー操作による投入（/api/ai/jobs）。 */
export async function enqueueJob(
  db: D1Database,
  user: Actor,
  input: { caseId: string; jobType: AiJobType; relatedTaskId?: string | null; input: AiJobInput },
) {
  await taskRole(db, user, false);
  const owned = await db
    .prepare(`SELECT c.id FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope}`)
    .bind(input.caseId, user.id)
    .first();
  if (!owned) throw notFound();
  if (
    input.relatedTaskId &&
    (await taskRow(db, user, input.relatedTaskId)).case_id !== input.caseId
  )
    throw notFound();
  return insertJob(db, input.caseId, input.relatedTaskId ?? null, input.jobType, input.input);
}

/**
 * 提出を契機とする投入（7-3）。couple の提出処理と planner の不備チェックから呼ぶ。
 * 同じ宿題・種別で取得前のジョブがあれば積み増さず、入力だけ最新の提出に差し替える。
 * 処理中のジョブは古い入力で走っているため、新しいジョブを足す（画面は最新を表示する）。
 */
export async function enqueueTaskJob(
  db: D1Database,
  user: Actor,
  taskId: string,
  jobType: Extract<AiJobType, 'classification' | 'defect_check'>,
  input: AiJobInput,
) {
  const task = await taskRow(db, user, taskId);
  const queued = await db
    .prepare(
      "UPDATE ai_jobs SET input_ref=?,updated_at=? WHERE id=(SELECT id FROM ai_jobs WHERE related_task_id=? AND job_type=? AND status='queued' ORDER BY created_at DESC LIMIT 1) AND status='queued' RETURNING id",
    )
    .bind(seal(input), new Date().toISOString(), taskId, jobType)
    .first<{ id: string }>();
  if (queued) return queued.id;
  // 二重送信などで同時に来ても queued を2件にしない（判定と追加を1文で行う）。
  const id = randomUUID(),
    now = new Date().toISOString();
  const inserted = await db
    .prepare(
      `INSERT INTO ai_jobs(id,venue_id,case_id,related_task_id,job_type,input_ref,status,created_at,updated_at) SELECT ?,venue_id,id,?,?,?,'queued',?,? FROM wedding_cases WHERE id=? AND NOT EXISTS(SELECT 1 FROM ai_jobs WHERE related_task_id=? AND job_type=? AND status='queued')`,
    )
    .bind(id, taskId, jobType, seal(input), now, now, task.case_id, taskId, jobType)
    .run();
  if (inserted.meta.changes) return id;
  return enqueueTaskJob(db, user, taskId, jobType, input);
}

/** 採用・破棄（7-1「出力は必ずプランナーの確認を経て利用する」）。 */
export async function reviewJob(
  db: D1Database,
  user: Actor,
  id: string,
  decision: 'confirmed' | 'discarded',
  output?: unknown,
) {
  const job = await jobRow(db, user, id);
  let revised: unknown = null;
  if (output !== undefined) {
    if (decision !== 'confirmed')
      throw badRequest([{ field: 'output', reason: '破棄する場合は内容を送れません' }]);
    const checked = validateAiOutput(job.job_type, output);
    if (!checked.ok) throw badRequest([{ field: 'output', reason: checked.error }]);
    revised = checked.value;
  }
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE ai_jobs AS j SET status=?,reviewed_output=?,confirmed_by=?,confirmed_at=?,updated_at=? WHERE j.id=? AND j.status='done' AND ${staffCase}`,
    )
    .bind(
      decision,
      decision === 'confirmed' ? seal(revised) : null,
      user.id,
      now,
      now,
      id,
      user.id,
      user.id,
    )
    .run();
  if (!result.meta.changes) throw conflict('このジョブはまだ確認できる状態ではありません');
  return { id, status: decision };
}

/** 9-4 ①をR2上の提出CSVにかける。読めない・CSVでない・期待列が無いときは null。 */
export async function checkStoredCsv(
  files: R2Bucket,
  file: { object_path: string; original_filename: string | null; mime_type: string | null },
  options: Record<string, unknown> | null,
) {
  const schema = csvSchemaOf(options);
  if (!schema || !looksLikeCsv(file.original_filename, file.mime_type)) return null;
  const object = await files.get(file.object_path);
  return object ? checkCsvText(await object.text(), schema) : null;
}

// ------------------------------------------------------------ ワーカー専用（共有トークン認証の内側だけで呼ぶ）

export async function workerPing(db: D1Database, worker: string, model: string | null) {
  await db
    .prepare(
      'INSERT INTO ai_worker_heartbeats(worker_name,model_name,last_seen_at) VALUES(?,?,?) ON CONFLICT(worker_name) DO UPDATE SET last_seen_at=excluded.last_seen_at,model_name=COALESCE(excluded.model_name,model_name)',
    )
    .bind(worker, model, new Date().toISOString())
    .run();
}

/** 1件だけ掴む。D1は文を直列に実行するため、条件付きUPDATEで二重取得を防げる。 */
export async function workerClaim(db: D1Database, worker: string, jobTypes: readonly string[]) {
  const types = jobTypes.filter((t) => (AI_JOB_TYPES as readonly string[]).includes(t));
  if (!types.length) return null;
  const now = new Date(),
    iso = now.toISOString(),
    stale = new Date(now.getTime() - STALE_MS).toISOString();
  // 定期処理を持たないため、取得のたびに滞留ジョブを回収する（7-3／6-12）。
  const [, , claimed] = await db.batch([
    db
      .prepare(
        "UPDATE ai_jobs SET status='failed',error_message='ワーカーからの応答がないまま試行回数の上限に達しました',locked_by=NULL,locked_at=NULL,finished_at=?,updated_at=? WHERE status='processing' AND locked_at<? AND attempts>=?",
      )
      .bind(iso, iso, stale, MAX_ATTEMPTS),
    db
      .prepare(
        "UPDATE ai_jobs SET status='queued',locked_by=NULL,locked_at=NULL,updated_at=? WHERE status='processing' AND locked_at<? AND attempts<?",
      )
      .bind(iso, stale, MAX_ATTEMPTS),
    db
      .prepare(
        `UPDATE ai_jobs SET status='processing',locked_by=?,locked_at=?,started_at=COALESCE(started_at,?),attempts=attempts+1,updated_at=? WHERE id=(SELECT id FROM ai_jobs WHERE status='queued' AND job_type IN (${types.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1) AND status='queued' RETURNING *`,
      )
      .bind(worker, iso, iso, iso, ...types),
  ]);
  const job = (claimed.results as unknown as (StoredJob & { venue_id: string })[])[0];
  if (!job) return null;
  // プロンプトは式場別を優先し、無ければ共通テンプレート（7-6）。
  const template = await db
    .prepare(
      'SELECT id,prompt_text,model_name FROM ai_prompt_templates WHERE job_type=? AND active=1 AND (venue_id=? OR venue_id IS NULL) ORDER BY venue_id IS NOT NULL DESC,version DESC LIMIT 1',
    )
    .bind(job.job_type, job.venue_id)
    .first<{ id: string; prompt_text: string; model_name: string | null }>();
  // 効果検証用の記録にすぎないので、失敗しても取得済みのジョブを返す（返さないと30分滞留する）。
  if (template)
    await db
      .prepare('UPDATE ai_jobs SET prompt_template_id=? WHERE id=?')
      .bind(template.id, job.id)
      .run()
      .catch((error: unknown) => console.warn('[ai] テンプレートIDを記録できませんでした', error));
  return {
    id: job.id,
    job_type: job.job_type,
    input_ref: open(job.input_ref) as AiJobInput,
    model_name: template?.model_name ?? job.model_name,
    prompt_text: template?.prompt_text ?? null,
    attempts: job.attempts,
  };
}

/** 結果の書込み。滞留回収後に戻ってきた古いワーカーが上書きしないよう locked_by を照合する。 */
export async function workerComplete(
  db: D1Database,
  worker: string,
  input: { id: string; output?: unknown; error?: string | null; model?: string | null },
) {
  const failed = Boolean(input.error);
  let output: unknown = null;
  if (!failed) {
    // 自分が掴んでいるジョブ以外は、存在や種別も返さない。
    const job = await db
      .prepare("SELECT job_type FROM ai_jobs WHERE id=? AND status='processing' AND locked_by=?")
      .bind(input.id, worker)
      .first<{ job_type: AiJobType }>();
    if (!job) return false;
    // ワーカー側でも検証済みだが、DBへ入る前にもう一度スキーマを通す（7-6）。
    const checked = validateAiOutput(job.job_type, input.output);
    if (!checked.ok) throw unprocessable(checked.error);
    output = checked.value;
  }
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      "UPDATE ai_jobs SET status=?,output=COALESCE(?,output),error_message=?,model_name=COALESCE(?,model_name),finished_at=?,locked_by=NULL,locked_at=NULL,updated_at=? WHERE id=? AND status='processing' AND locked_by=?",
    )
    .bind(
      failed ? 'failed' : 'done',
      failed ? null : seal(output),
      // 画面に出る文言なので、LLM出力の断片が紛れても長く残らないよう短く切る。
      failed ? String(input.error).slice(0, 200) : null,
      input.model ?? null,
      now,
      now,
      input.id,
      worker,
    )
    .run();
  return Boolean(result.meta.changes);
}

/** 滞留回収の単体実行 (6-12 ai_job_reclaim)。workerClaim の取得時回収と同じ条件を定期処理からも実行する。 */
export async function reclaimStalledAiJobs(db: D1Database, now = new Date()) {
  const iso = now.toISOString();
  const stale = new Date(now.getTime() - STALE_MS).toISOString();
  const failedRow = await db
    .prepare(
      "SELECT count(*) AS n FROM ai_jobs WHERE status='processing' AND locked_at<? AND attempts>=?",
    )
    .bind(stale, MAX_ATTEMPTS)
    .first<{ n: number }>();
  const requeuedRow = await db
    .prepare(
      "SELECT count(*) AS n FROM ai_jobs WHERE status='processing' AND locked_at<? AND attempts<?",
    )
    .bind(stale, MAX_ATTEMPTS)
    .first<{ n: number }>();
  await db.batch([
    db
      .prepare(
        "UPDATE ai_jobs SET status='failed',error_message='ワーカーからの応答がないまま試行回数の上限に達しました',locked_by=NULL,locked_at=NULL,finished_at=?,updated_at=? WHERE status='processing' AND locked_at<? AND attempts>=?",
      )
      .bind(iso, iso, stale, MAX_ATTEMPTS),
    db
      .prepare(
        "UPDATE ai_jobs SET status='queued',locked_by=NULL,locked_at=NULL,updated_at=? WHERE status='processing' AND locked_at<? AND attempts<?",
      )
      .bind(iso, stale, MAX_ATTEMPTS),
  ]);
  return { requeued: requeuedRow?.n ?? 0, failed: failedRow?.n ?? 0 };
}
