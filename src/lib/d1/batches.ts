/**
 * 定期処理の実行記録 (batch_runs) の D1 版 (6-12)。
 * Supabase 版 src/lib/api/internal.ts の runBatch / forEachActiveCase と同じ契約:
 * 記録は成功・失敗どちらでも残し、開始記録が書けなければ副作用を始めない。
 */
import type { D1Database } from '@cloudflare/workers-types';

import type { BatchJobType } from '@/lib/api/internal';

export type { BatchJobType };
export interface BatchOutcome {
  targetCount: number;
  detail?: Record<string, unknown>;
}
export class BatchFailure extends Error {
  constructor(
    message: string,
    readonly outcome: BatchOutcome,
  ) {
    super(message);
    this.name = 'BatchFailure';
  }
}

export async function startBatchRun(db: D1Database, jobType: BatchJobType): Promise<string> {
  const id = crypto.randomUUID();
  try {
    const r = await db
      .prepare('INSERT INTO batch_runs(id,job_type,started_at) VALUES (?,?,?) RETURNING id')
      .bind(id, jobType, new Date().toISOString())
      .first<{ id: string }>();
    if (!r?.id) throw new Error();
  } catch {
    throw new Error('バッチの開始記録を保存できませんでした');
  }
  return id;
}

export async function finishBatchRun(
  db: D1Database,
  runId: string,
  patch: {
    targetCount?: number;
    httpStatus: number;
    detail?: Record<string, unknown>;
    errorMessage?: string;
  },
): Promise<void> {
  const r = await db
    .prepare(
      'UPDATE batch_runs SET finished_at=?,target_count=?,http_status=?,detail=?,error_message=? WHERE id=? RETURNING id',
    )
    .bind(
      new Date().toISOString(),
      patch.targetCount ?? 0,
      patch.httpStatus,
      JSON.stringify(patch.detail ?? {}),
      patch.errorMessage ?? null,
      runId,
    )
    .first<{ id: string }>();
  if (!r?.id) throw new Error('バッチの終了記録を保存できませんでした');
}

export async function runBatchD1(
  db: D1Database,
  jobType: BatchJobType,
  fn: () => Promise<BatchOutcome>,
): Promise<BatchOutcome> {
  const runId = await startBatchRun(db, jobType);
  let outcome: BatchOutcome;
  try {
    outcome = await fn();
  } catch (error) {
    try {
      await finishBatchRun(db, runId, {
        httpStatus: 500,
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(error instanceof BatchFailure
          ? { targetCount: error.outcome.targetCount, detail: error.outcome.detail }
          : {}),
      });
    } catch {
      console.error('[batch] 失敗記録を保存できませんでした', { jobType, runId });
    }
    throw error;
  }
  await finishBatchRun(db, runId, {
    targetCount: outcome.targetCount,
    httpStatus: 200,
    detail: outcome.detail ?? {},
  });
  return outcome;
}

export interface BatchRunRow {
  id: string;
  job_type: BatchJobType;
  started_at: string;
  finished_at: string | null;
  target_count: number;
  http_status: number | null;
  detail: Record<string, unknown>;
  error_message: string | null;
}

export async function listBatchRuns(
  db: D1Database,
  jobType?: BatchJobType,
  limit = 50,
): Promise<BatchRunRow[]> {
  const q = jobType
    ? db
        .prepare(
          'SELECT * FROM batch_runs WHERE job_type=? ORDER BY started_at DESC,id DESC LIMIT ?',
        )
        .bind(jobType, limit)
    : db.prepare('SELECT * FROM batch_runs ORDER BY started_at DESC,id DESC LIMIT ?').bind(limit);
  const { results } = await q.all<Omit<BatchRunRow, 'detail'> & { detail: string }>();
  return results.map((r) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      detail = {};
    }
    return { ...r, detail };
  });
}

/** venue_id → case_id の順に進行中の案件を辿る (Supabase 版 forEachActiveCase と同等)。 */
export async function forEachActiveCaseD1(
  db: D1Database,
  handler: (caseId: string, venueId: string) => Promise<void>,
): Promise<number> {
  // D1 の venues には active 列が無い (存在する式場は全て有効として扱う)。
  const { results } = await db
    .prepare(
      "SELECT id,venue_id FROM wedding_cases WHERE archived_at IS NULL AND status IN ('draft','active') ORDER BY venue_id,id",
    )
    .all<{ id: string; venue_id: string }>();
  let processed = 0;
  for (const row of results) {
    await handler(row.id, row.venue_id);
    processed += 1;
  }
  return processed;
}
