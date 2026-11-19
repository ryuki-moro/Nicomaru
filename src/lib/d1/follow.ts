import type { D1Database } from '@cloudflare/workers-types';
import type { AppUser } from '@/lib/auth/session';
import type { FollowMethod } from '@/lib/constants';
import { forbidden, notFound } from '@/lib/errors';
import { caseRow, scope } from './cases';

export interface FollowLog {
  id: string;
  case_id: string;
  planner_id: string;
  method: FollowMethod;
  note: string | null;
  followed_at: string;
  created_at: string;
}
export async function listFollowLogs(
  db: D1Database,
  user: AppUser,
  caseId: string,
  offset = 0,
  limit = 50,
) {
  if (user.role === 'couple') throw forbidden();
  await caseRow(db, user, caseId);
  const { results } = await db
    .prepare(
      `SELECT f.* FROM follow_logs f JOIN wedding_cases c ON c.id=f.case_id WHERE c.id=? AND c.archived_at IS NULL AND ${scope} ORDER BY f.followed_at DESC,f.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(caseId, user.id, limit + 1, offset)
    .all<FollowLog>();
  return { items: results.slice(0, limit), hasNext: results.length > limit, offset, limit };
}
export async function createFollowLog(
  db: D1Database,
  user: AppUser,
  caseId: string,
  input: { method: FollowMethod; note?: string | null; followedAt: string },
) {
  if (user.role === 'couple') throw forbidden();
  const id = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO follow_logs(id,case_id,planner_id,method,note,followed_at)
    SELECT ?,c.id,?,?,?,? FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope}
    AND EXISTS (SELECT 1 FROM user_profiles a WHERE a.id=? AND a.status='active' AND a.role IN ('planner','admin','system_admin')) RETURNING *`,
    )
    .bind(id, user.id, input.method, input.note ?? null, input.followedAt, caseId, user.id, user.id)
    .first<FollowLog>();
  if (!row) throw notFound();
  return row;
}

/** 実行者はセッションから確定し、他の案件の履歴を書けないようD1でも再検証する。 */
export async function logCommunication(
  db: D1Database,
  user: Pick<AppUser, 'id'>,
  caseId: string,
  input: {
    channel: import('@/lib/services/communication').CommunicationChannel;
    direction: import('@/lib/services/communication').CommunicationDirection;
    summary: string;
  },
) {
  const row = await db
    .prepare(
      `INSERT INTO communication_logs(id,case_id,channel,direction,summary,created_by)
    SELECT ?,c.id,?,?,?,? FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope} RETURNING id`,
    )
    .bind(
      crypto.randomUUID(),
      input.channel,
      input.direction,
      input.summary,
      user.id,
      caseId,
      user.id,
    )
    .first<{ id: string }>();
  if (!row) throw notFound();
  return row.id;
}
export async function listCommunications(
  db: D1Database,
  user: AppUser,
  caseId: string,
  offset = 0,
  limit = 50,
) {
  if (user.role === 'couple') throw forbidden();
  await caseRow(db, user, caseId);
  return (
    await db
      .prepare(
        `SELECT l.* FROM communication_logs l JOIN wedding_cases c ON c.id=l.case_id WHERE c.id=? AND ${scope} ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(caseId, user.id, limit, offset)
      .all()
  ).results;
}
