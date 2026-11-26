import type { AppUser } from '@/lib/auth/session';
import { encryptPii, readPii } from '@/lib/crypto';
import { badRequest, conflict, notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import type { D1Database } from '@cloudflare/workers-types';
import { scope } from './cases';

/** 送信者が取り消せる時間 */
export const MESSAGE_RETRACT_WINDOW_MS = 15 * 60 * 1000;
// D1 の束縛変数は1文あたり100個まで。scope と既読の分を引いた余裕を持たせる。
const UNREAD_CHUNK = 50;
const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface MessageView {
  id: string;
  caseId: string;
  senderUserId: string;
  senderName: string;
  senderSide: 'staff' | 'couple';
  body: string | null;
  createdAt: string;
  retracted: boolean;
  mine: boolean;
  cursor: string;
}

interface MessageRow {
  id: string;
  case_id: string;
  sender_user_id: string;
  body_enc: string | null;
  created_at: string;
  deleted_at: string | null;
  sender_name: string | null;
  sender_role: string | null;
}

export const encodeCursor = (createdAt: string, id: string) => `${createdAt}_${id}`;

export function decodeCursor(value: string): { createdAt: string; id: string } | null {
  const parts = value.split('_');
  if (parts.length !== 2) return null;
  const [createdAt, id] = parts;
  return CREATED_AT_PATTERN.test(createdAt) && isUuid(id) ? { createdAt, id } : null;
}

function parseCursor(value: string) {
  const cursor = decodeCursor(value);
  if (!cursor) throw badRequest([{ field: 'cursor', reason: 'カーソルの形式が正しくありません' }]);
  return cursor;
}

function toView(row: MessageRow, user: AppUser): MessageView {
  const retracted = row.deleted_at !== null;
  return {
    id: row.id,
    caseId: row.case_id,
    senderUserId: row.sender_user_id,
    senderName: row.sender_name ?? '',
    senderSide: row.sender_role === 'couple' ? 'couple' : 'staff',
    body: retracted ? null : readPii(row.body_enc),
    createdAt: row.created_at,
    retracted,
    mine: row.sender_user_id === user.id,
    cursor: encodeCursor(row.created_at, row.id),
  };
}

// 送信者名は他の画面と同じく better-auth の "user".name、staff / couple の別は user_profiles.role から引く。
const SELECT_MESSAGE = `SELECT m.id,m.case_id,m.sender_user_id,m.body_enc,m.created_at,m.deleted_at,
  u.name AS sender_name,p.role AS sender_role
  FROM case_messages m LEFT JOIN "user" u ON u.id=m.sender_user_id LEFT JOIN user_profiles p ON p.id=m.sender_user_id`;

/** 案件の参加者だけが読める。アーカイブ済みは管理者のみ (scope の定義どおり)。 */
async function assertCaseAccess(db: D1Database, user: AppUser, caseId: string) {
  const row = await db
    .prepare(`SELECT c.id FROM wedding_cases c WHERE c.id=? AND ${scope}`)
    .bind(caseId, user.id)
    .first();
  if (!row) throw notFound();
}

export async function listMessages(
  db: D1Database,
  user: AppUser,
  caseId: string,
  opts: { after?: string; before?: string; limit: number },
): Promise<{ items: MessageView[]; hasMore: boolean }> {
  if (opts.after !== undefined && opts.before !== undefined) throw badRequest();
  const after = opts.after !== undefined ? parseCursor(opts.after) : null;
  const before = opts.before !== undefined ? parseCursor(opts.before) : null;
  await assertCaseAccess(db, user, caseId);
  const bound = after ?? before;
  const cmp = after ? '>' : '<';
  const order = after ? 'ASC' : 'DESC';
  const params: (string | number)[] = [caseId];
  if (bound) params.push(bound.createdAt, bound.createdAt, bound.id);
  params.push(opts.limit + 1);
  const { results } = await db
    .prepare(
      `${SELECT_MESSAGE} WHERE m.case_id=?${
        bound ? ` AND (m.created_at${cmp}? OR (m.created_at=? AND m.id${cmp}?))` : ''
      } ORDER BY m.created_at ${order},m.id ${order} LIMIT ?`,
    )
    .bind(...params)
    .all<MessageRow>();
  const hasMore = results.length > opts.limit;
  const page = results.slice(0, opts.limit);
  if (!after) page.reverse();
  return { items: page.map((row) => toView(row, user)), hasMore };
}

const upsertRead = (db: D1Database, caseId: string, userId: string, at: string, now: string) =>
  db
    .prepare(
      `INSERT INTO case_message_reads(case_id,user_id,last_read_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(case_id,user_id) DO UPDATE SET last_read_at=MAX(last_read_at,excluded.last_read_at),updated_at=excluded.updated_at`,
    )
    .bind(caseId, userId, at, now);

export async function postMessage(
  db: D1Database,
  user: AppUser,
  caseId: string,
  body: string,
): Promise<MessageView> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT INTO case_messages(id,case_id,sender_user_id,body_enc,created_at)
    SELECT ?,c.id,?,?,? FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope} RETURNING id`,
    )
    .bind(id, user.id, encryptPii(body), now, caseId, user.id)
    .first<{ id: string }>();
  if (!inserted) throw notFound();
  // 自分の発言は既読として扱う
  await upsertRead(db, caseId, user.id, now, now).run();
  const row = await db.prepare(`${SELECT_MESSAGE} WHERE m.id=?`).bind(id).first<MessageRow>();
  if (!row) throw notFound();
  return toView(row, user);
}

export async function retractMessage(
  db: D1Database,
  user: AppUser,
  messageId: string,
  now = Date.now(),
): Promise<{ caseId: string; cursor: string }> {
  const cutoff = new Date(now - MESSAGE_RETRACT_WINDOW_MS).toISOString();
  const mine = `id=? AND sender_user_id=? AND EXISTS (SELECT 1 FROM wedding_cases c WHERE c.id=case_messages.case_id AND ${scope})`;
  const done = await db
    .prepare(
      `UPDATE case_messages SET deleted_at=?,body_enc=NULL WHERE ${mine} AND deleted_at IS NULL AND created_at>=? RETURNING case_id,id,created_at`,
    )
    .bind(new Date(now).toISOString(), messageId, user.id, user.id, cutoff)
    .first<{ case_id: string; id: string; created_at: string }>();
  if (done) return { caseId: done.case_id, cursor: encodeCursor(done.created_at, done.id) };
  // 更新できなかった理由を分ける: 自分の発言でなければ 404、状態が許さなければ 409
  const found = await db
    .prepare(`SELECT 1 AS ok FROM case_messages WHERE ${mine}`)
    .bind(messageId, user.id, user.id)
    .first();
  if (!found) throw notFound();
  throw conflict('送信から時間が経っているか、すでに取り消されています');
}

export async function markRead(
  db: D1Database,
  user: AppUser,
  caseId: string,
  cursor: string,
): Promise<void> {
  const parsed = parseCursor(cursor);
  const now = new Date().toISOString();
  const row = await db
    .prepare(
      `INSERT INTO case_message_reads(case_id,user_id,last_read_at,updated_at)
    SELECT c.id,?,?,? FROM wedding_cases c WHERE c.id=? AND ${scope}
    ON CONFLICT(case_id,user_id) DO UPDATE SET last_read_at=MAX(last_read_at,excluded.last_read_at),updated_at=excluded.updated_at RETURNING case_id`,
    )
    .bind(user.id, parsed.createdAt, now, caseId, user.id)
    .first();
  if (!row) throw notFound();
}

export async function unreadCounts(
  db: D1Database,
  user: AppUser,
  caseIds: string[],
): Promise<Record<string, number>> {
  const unique = [...new Set(caseIds)];
  const counts: Record<string, number> = {};
  for (let i = 0; i < unique.length; i += UNREAD_CHUNK) {
    const chunk = unique.slice(i, i + UNREAD_CHUNK);
    const { results } = await db
      .prepare(
        `SELECT c.id AS case_id,(SELECT count(*) FROM case_messages m WHERE m.case_id=c.id AND m.sender_user_id<>? AND m.deleted_at IS NULL
      AND m.created_at>COALESCE((SELECT r.last_read_at FROM case_message_reads r WHERE r.case_id=c.id AND r.user_id=?),'')) AS n
      FROM wedding_cases c WHERE c.id IN (${chunk.map(() => '?').join(',')}) AND ${scope}`,
      )
      .bind(user.id, user.id, ...chunk, user.id)
      .all<{ case_id: string; n: number }>();
    for (const r of results) counts[r.case_id] = r.n;
  }
  return counts;
}
