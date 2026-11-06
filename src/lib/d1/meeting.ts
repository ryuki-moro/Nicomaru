/**
 * D05 打ち合わせ記録＋AI宿題起票案（9-5）のD1実装。
 *
 * D1 AI基盤（src/lib/d1/ai.ts の enqueueJob、job_type='task_extraction'）へ置き換えたもの。
 * 起票案の登録は既存の D1 宿題追加（src/lib/d1/tasks.ts の addTask／
 * POST /api/cases/{caseId}/tasks）を使う。AI専用の登録経路は作らない。
 * 権限は cases.ts の scope 述語と staff ロールで担保する（RLSの代替）。
 */
import { trimForAi } from '@/lib/ai/assist';
import type { AppUser } from '@/lib/auth/session';
import { INPUT_LIMITS } from '@/lib/constants';
import { notFound } from '@/lib/errors';
import type { D1Database } from '@cloudflare/workers-types';
import { randomUUID } from 'node:crypto';
import { aiAssistStatus, enqueueJob, latestJobForCase } from './ai';
import { scope } from './cases';
import { taskRole } from './tasks';

type Actor = Pick<AppUser, 'id'>;

export interface D1MeetingNote {
  id: string;
  meeting_date: string | null;
  participants: string | null;
  body: string;
  created_at: string;
  user_profiles: { display_name: string } | null;
}

export async function listNotes(
  db: D1Database,
  user: Actor,
  caseId: string,
  limit = 10,
): Promise<D1MeetingNote[]> {
  await taskRole(db, user, false);
  const rows = await db
    .prepare(
      `SELECT n.id,n.meeting_date,n.participants,n.body,n.created_at,u.name AS display_name FROM meeting_notes n LEFT JOIN "user" u ON u.id=n.created_by WHERE n.case_id=? AND EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=n.case_id AND ${scope}) AND EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.status='active' AND r.role IN ('planner','admin','system_admin')) ORDER BY n.created_at DESC LIMIT ?`,
    )
    .bind(caseId, user.id, user.id, limit)
    .all<{
      id: string;
      meeting_date: string | null;
      participants: string | null;
      body: string;
      created_at: string;
      display_name: string | null;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    meeting_date: r.meeting_date,
    participants: r.participants,
    body: r.body,
    created_at: r.created_at,
    user_profiles: r.display_name ? { display_name: r.display_name } : null,
  }));
}

/**
 * 記録を保存し、保存成功後に task_extraction ジョブを投入する（7-3）。
 * ジョブ投入に失敗しても記録は残す（AIは補助。7-1）。その場合は jobId=null を返す。
 */
export async function saveNote(
  db: D1Database,
  user: Actor,
  input: {
    caseId: string;
    body: string;
    meetingDate?: string | null;
    participants?: string | null;
  },
): Promise<{ id: string; jobId: string | null }> {
  await taskRole(db, user, false);
  const body = input.body.trim().slice(0, INPUT_LIMITS.textArea);
  if (!body) throw notFound();
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO meeting_notes(id,case_id,created_by,meeting_date,participants,body,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope}) AND EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.status='active' AND r.role IN ('planner','admin','system_admin'))`,
    )
    .bind(
      id,
      input.caseId,
      user.id,
      input.meetingDate || null,
      input.participants || null,
      body,
      now,
      now,
      input.caseId,
      user.id,
      user.id,
    )
    .run();
  if (!result.meta.changes) throw notFound();

  // 7-4「LLMへの入力は最小限」。渡すのはメモ本文だけ（参加者名・案件番号は含めない）。
  let jobId: string | null = null;
  const text = trimForAi(body);
  if (text) {
    try {
      jobId = await enqueueJob(db, user as AppUser, {
        caseId: input.caseId,
        jobType: 'task_extraction',
        input: { ref: { table: 'meeting_notes', id }, text, params: {} },
      });
    } catch (error) {
      console.warn('[meeting-notes] 起票案を依頼できませんでした', error);
    }
  }
  return { id, jobId };
}

export async function extractionState(db: D1Database, user: Actor, caseId: string) {
  const [status, job] = await Promise.all([
    aiAssistStatus(db).catch(() => ({ available: false, lastSeenAt: null })),
    latestJobForCase(db, user, caseId, 'task_extraction').catch(() => null),
  ]);
  return { status, job };
}
