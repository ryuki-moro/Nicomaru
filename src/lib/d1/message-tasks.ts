/** チャットのメッセージから、スタッフがやることを作る。 */
import type { AppUser } from '@/lib/auth/session';
import { conflict, notFound } from '@/lib/errors';
import type { caseTaskCreateSchema } from '@/lib/validation';
import type { D1Database } from '@cloudflare/workers-types';
import type { z } from 'zod';
import { scope } from './cases';
import { announceSystemMessage } from './system-messages';
import { addTask } from './tasks';

/**
 * 元のメッセージの案件で、スタッフが見られる未アーカイブのときだけ作れる。
 * 新郎新婦・範囲外・存在しないメッセージは 404、取り消し済みとシステムメッセージは 409。
 */
export async function createTaskFromMessage(
  db: D1Database,
  user: AppUser,
  messageId: string,
  input: z.infer<typeof caseTaskCreateSchema>,
) {
  const message = await db
    .prepare(
      `SELECT m.case_id,m.kind,m.deleted_at FROM case_messages m JOIN wedding_cases c ON c.id=m.case_id
    WHERE m.id=? AND c.archived_at IS NULL AND ${scope}
    AND EXISTS(SELECT 1 FROM user_profiles r WHERE r.id=? AND r.status='active' AND r.role IN ('planner','admin'))`,
    )
    .bind(messageId, user.id, user.id)
    .first<{ case_id: string; kind: string; deleted_at: string | null }>();
  if (!message) throw notFound();
  if (message.deleted_at) throw conflict('取り消されたメッセージからは、やることを作れません');
  if (message.kind !== 'user') throw conflict('システムメッセージからは、やることを作れません');
  // 確認のあとに取り消されたときは、addTask の INSERT 条件で弾かれる
  const created = await addTask(db, user, message.case_id, input, messageId).catch(async (e) => {
    const now = await db
      .prepare('SELECT deleted_at FROM case_messages WHERE id=?')
      .bind(messageId)
      .first<{ deleted_at: string | null }>();
    if (now?.deleted_at) throw conflict('取り消されたメッセージからは、やることを作れません');
    throw e;
  });
  await announceSystemMessage(
    db,
    message.case_id,
    'task_created',
    [{ type: 'task', id: created.id }],
    user.id,
  );
  return { ...created, caseId: message.case_id };
}
