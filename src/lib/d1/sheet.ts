/**
 * D03 準備シートのD1実装（機能4-5／9-2）。
 *
 * Supabase版 page.tsx のサーバー処理を、D1（meeting_sheets 0014）＋
 * D1 AI基盤（src/lib/d1/ai.ts）へ置き換えたもの。
 * 権限は cases.ts の scope 述語と staff ロールで担保する（RLSの代替）。
 * フォロー記録・連絡履歴は D1 にテーブルが無いため、シートでは空として扱う
 * （Supabase完全削除マップ §2 行10・行17。移行は別Wave）。
 */
import { randomUUID } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { AppUser } from '@/lib/auth/session';
import { INCOMPLETE_TASK_STATUSES, TASK_STATUS_LABEL, type TaskStatus } from '@/lib/constants';
import { notFound } from '@/lib/errors';
import { formatDate, todayInJst } from '@/lib/format';
import { aiAssistStatus, enqueueJob, latestJobForCase } from './ai';
import { caseRow, scope } from './cases';
import { taskRole } from './tasks';

type Actor = Pick<AppUser, 'id'>;

const sheetAccess = `EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=case_id AND c.archived_at IS NULL AND ${scope}) AND EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.status='active' AND r.role IN ('planner','admin','system_admin'))`;

export interface D1Sheet {
  id: string;
  generated_at: string;
  summary_json: string;
  ai_draft_job_id: string | null;
}

/** シート表示に必要な案件一式（caseRow の scope で認可済み）＋前回記録。 */
export async function sheetData(db: D1Database, user: AppUser, caseId: string) {
  const target = await caseRow(db, user, caseId);
  const last = await db
    .prepare(
      `SELECT id,generated_at,summary_json,ai_draft_job_id FROM meeting_sheets WHERE case_id=? AND ${sheetAccess} ORDER BY generated_at DESC LIMIT 1`,
    )
    .bind(caseId, user.id, user.id)
    .first<D1Sheet>();
  return { target, lastSheet: last ?? null };
}

/** 生成した内容を meeting_sheets に残す（機能4-5）。 */
export async function recordSheet(
  db: D1Database,
  user: Actor,
  caseId: string,
  summary: unknown,
  aiDraftJobId?: string | null,
) {
  await taskRole(db, user, false);
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO meeting_sheets(id,case_id,generated_by,summary_json,ai_draft_job_id,generated_at,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope}) AND EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.status='active' AND r.role IN ('planner','admin','system_admin'))`,
    )
    .bind(
      id,
      caseId,
      user.id,
      JSON.stringify(summary ?? {}),
      aiDraftJobId ?? null,
      now,
      now,
      caseId,
      user.id,
      user.id,
    )
    .run();
  if (!result.meta.changes) throw notFound();
  return id;
}

/**
 * 9-2 要点下書きの依頼。LLMへ渡す内容はサーバー側で組み立てる（7-4 入力最小化）。
 * 渡すのは未提出宿題の件名・期限だけ（連絡履歴はD1未移行のため含めない）。氏名・連絡先は含めない。
 */
export async function requestSheetDraft(db: D1Database, user: AppUser, caseId: string) {
  const target = await caseRow(db, user, caseId);
  const today = todayInJst();
  const pending = target.case_tasks
    .filter((t) => (INCOMPLETE_TASK_STATUSES as readonly string[]).includes(t.status))
    .slice(0, 20);
  const pendingLines = pending.map(
    (t) =>
      `・${t.title}（期限 ${formatDate(t.due_date.slice(0, 10))}／${TASK_STATUS_LABEL[t.status as TaskStatus]}）`,
  );
  const text = [
    `本日: ${formatDate(today)}`,
    pendingLines.length > 0 ? `未提出の宿題:\n${pendingLines.join('\n')}` : '未提出の宿題: なし',
    '直近の連絡: なし（D1では連絡履歴は未移行）',
  ].join('\n\n');
  return enqueueJob(db, user, {
    caseId,
    jobType: 'draft',
    input: { text, params: { purpose: 'meeting_sheet_summary' } },
  });
}

export async function sheetDraftState(db: D1Database, user: Actor, caseId: string) {
  const [status, job] = await Promise.all([
    aiAssistStatus(db).catch(() => ({ available: false, lastSeenAt: null })),
    latestJobForCase(db, user, caseId, 'draft').catch(() => null),
  ]);
  return { status, job };
}
