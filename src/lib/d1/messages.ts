import type { AppUser } from '@/lib/auth/session';
import { encryptPii, readPii } from '@/lib/crypto';
import { badRequest, conflict, notFound } from '@/lib/errors';
import { isStaff } from '@/lib/constants';
import { isUuid } from '@/lib/uuid';
import type { D1Database } from '@cloudflare/workers-types';
import { scope } from './cases';

/** 送信者が取り消せる時間 */
export const MESSAGE_RETRACT_WINDOW_MS = 15 * 60 * 1000;
// D1 の束縛変数は1文あたり100個まで。scope と既読の分を引いた余裕を持たせる。
const UNREAD_CHUNK = 50;
const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 1メッセージに添付できる参照の上限 */
export const MAX_MESSAGE_REFS = 3;
export const REF_TYPES = ['task', 'guest', 'seating'] as const;
export type RefType = (typeof REF_TYPES)[number];
export const CHAT_EVENT_TYPES = [
  'task_submitted',
  'task_approved',
  'task_returned',
  'task_due_soon',
  'task_overdue',
  'seating_submitted',
  'seating_approved',
  'seating_returned',
  'task_created',
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export interface RefInput {
  type: RefType;
  id: string;
}

/** title が null のときは、権限がないか消えた項目（題名などは漏らさない） */
export interface RefView extends RefInput {
  title: string | null;
  href: string | null;
  status: string | null;
}

export interface MessageView {
  id: string;
  caseId: string;
  kind: 'user' | 'system';
  /** システムメッセージのときだけ値がある */
  eventType: ChatEventType | null;
  /** システムメッセージは発言者がいない */
  senderUserId: string | null;
  senderName: string;
  senderSide: 'staff' | 'couple';
  /** システムメッセージは event_type と参照から組み立てた文面。参照だけの投稿は空文字 */
  body: string | null;
  createdAt: string;
  retracted: boolean;
  mine: boolean;
  cursor: string;
  refs: RefView[];
  /** このメッセージから作ったやること */
  linkedTaskIds: string[];
}

interface MessageRow {
  id: string;
  case_id: string;
  kind: 'user' | 'system';
  event_type: ChatEventType | null;
  sender_user_id: string | null;
  actor_user_id: string | null;
  body_enc: string | null;
  created_at: string;
  deleted_at: string | null;
  sender_name: string | null;
  sender_role: string | null;
  actor_name: string | null;
}

const UNAVAILABLE = '表示できない項目';
const chunks = <T>(items: readonly T[]) =>
  Array.from({ length: Math.ceil(items.length / UNREAD_CHUNK) }, (_, i) =>
    items.slice(i * UNREAD_CHUNK, (i + 1) * UNREAD_CHUNK),
  );
const placeholders = (items: readonly unknown[]) => items.map(() => '?').join(',');
const refKey = (ref: RefInput) => `${ref.type}:${ref.id}`;

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

interface ResolvedRef {
  title: string;
  status: string | null;
}

/**
 * 参照を、見る人の権限（scope）で引き直す。範囲外・消えた項目は結果に入らない。
 * 席次は案件に1つなので、ref_id が案件 ID のときだけ有効。
 */
export async function resolveRefs(
  db: D1Database,
  user: AppUser,
  caseId: string,
  refs: readonly RefInput[],
): Promise<Map<string, ResolvedRef>> {
  const found = new Map<string, ResolvedRef>();
  const idsOf = (type: RefType) => [
    ...new Set(refs.filter((r) => r.type === type).map((r) => r.id)),
  ];
  const lookups = [
    {
      type: 'task' as const,
      sql: (ids: string[]) =>
        `SELECT t.id,t.title AS title,t.status AS status FROM case_tasks t JOIN wedding_cases c ON c.id=t.case_id WHERE t.case_id=? AND t.id IN (${placeholders(ids)}) AND ${scope}`,
      title: (v: string) => v,
    },
    {
      type: 'guest' as const,
      sql: (ids: string[]) =>
        `SELECT g.id,g.full_name AS title,NULL AS status FROM case_guests g JOIN wedding_cases c ON c.id=g.case_id WHERE g.case_id=? AND g.id IN (${placeholders(ids)}) AND ${scope}`,
      title: (v: string) => readPii(v),
    },
  ];
  for (const lookup of lookups) {
    for (const chunk of chunks(idsOf(lookup.type))) {
      const { results } = await db
        .prepare(lookup.sql(chunk))
        .bind(caseId, ...chunk, user.id)
        .all<{ id: string; title: string; status: string | null }>();
      for (const r of results)
        found.set(refKey({ type: lookup.type, id: r.id }), {
          title: lookup.title(r.title),
          status: r.status,
        });
    }
  }
  if (idsOf('seating').includes(caseId)) {
    const row = await db
      .prepare(
        `SELECT COALESCE((SELECT s.status FROM seating_charts s WHERE s.case_id=c.id),'draft') AS status FROM wedding_cases c WHERE c.id=? AND ${scope}`,
      )
      .bind(caseId, user.id)
      .first<{ status: string }>();
    if (row)
      found.set(refKey({ type: 'seating', id: caseId }), { title: '席次表', status: row.status });
  }
  return found;
}

// 移動先はスタッフ（案件詳細のアンカー）と新郎新婦（マイページ）で別
const STAFF_ANCHOR: Record<RefType, string> = {
  task: 'tasks',
  guest: 'guests',
  seating: 'seating',
};
function refHref(user: AppUser, caseId: string, ref: RefInput): string {
  if (isStaff(user.role)) return `/cases/${caseId}#${STAFF_ANCHOR[ref.type]}`;
  return ref.type === 'task' ? `/mypage/tasks/${ref.id}` : `/mypage/${STAFF_ANCHOR[ref.type]}`;
}

const EVENT_TEXT: Record<ChatEventType, (actor: string, title: string) => string> = {
  task_submitted: (actor, title) => `${actor}『${title}』を提出しました`,
  task_approved: (actor, title) => `${actor}『${title}』を承認しました`,
  task_returned: (actor, title) => `${actor}『${title}』の修正を依頼しました`,
  task_due_soon: (_, title) => `『${title}』の期限が近づいています`,
  task_overdue: (_, title) => `『${title}』の期限が過ぎています`,
  seating_submitted: (actor) => `${actor}席次を提出しました`,
  seating_approved: (actor) => `${actor}席次を確定しました`,
  seating_returned: (actor) => `${actor}席次の修正を依頼しました`,
  task_created: (actor, title) => `${actor}『${title}』を作成しました`,
};

/** システムメッセージの文面は保存せず、読むたびに組み立てる */
function systemText(row: MessageRow, refs: RefView[]): string {
  const title = refs.find((r) => r.type === 'task')?.title ?? UNAVAILABLE;
  const actor = row.actor_name ? `${row.actor_name}さんが` : '';
  return EVENT_TEXT[row.event_type as ChatEventType](actor, title);
}

function toView(
  row: MessageRow,
  user: AppUser,
  refs: RefView[],
  linkedTaskIds: string[],
): MessageView {
  const retracted = row.deleted_at !== null;
  const shownRefs = retracted ? [] : refs;
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    eventType: row.event_type,
    senderUserId: row.sender_user_id,
    senderName: row.sender_name ?? '',
    senderSide: row.sender_role === 'couple' ? 'couple' : 'staff',
    body: retracted
      ? null
      : row.kind === 'system'
        ? systemText(row, shownRefs)
        : readPii(row.body_enc),
    createdAt: row.created_at,
    retracted,
    mine: row.sender_user_id !== null && row.sender_user_id === user.id,
    cursor: encodeCursor(row.created_at, row.id),
    refs: shownRefs,
    linkedTaskIds,
  };
}

// 送信者名は他の画面と同じく better-auth の "user".name、staff / couple の別は user_profiles.role から引く。
const SELECT_MESSAGE = `SELECT m.id,m.case_id,m.kind,m.event_type,m.sender_user_id,m.actor_user_id,m.body_enc,m.created_at,m.deleted_at,
  u.name AS sender_name,p.role AS sender_role,au.name AS actor_name
  FROM case_messages m LEFT JOIN "user" u ON u.id=m.sender_user_id LEFT JOIN user_profiles p ON p.id=m.sender_user_id
  LEFT JOIN "user" au ON au.id=m.actor_user_id`;

/** 1ページ分の参照とやること化の対応を、まとめて引いて見る人の権限で表示用にする。 */
async function hydrate(
  db: D1Database,
  user: AppUser,
  caseId: string,
  rows: MessageRow[],
): Promise<MessageView[]> {
  const stored: (RefInput & { message_id: string })[] = [];
  const linked = new Map<string, string[]>();
  for (const chunk of chunks(rows.map((r) => r.id))) {
    const refRows = await db
      .prepare(
        `SELECT message_id,ref_type AS type,ref_id AS id FROM case_message_refs WHERE message_id IN (${placeholders(chunk)}) ORDER BY message_id,position`,
      )
      .bind(...chunk)
      .all<RefInput & { message_id: string }>();
    stored.push(...refRows.results);
    const taskRows = await db
      .prepare(
        `SELECT id,source_message_id FROM case_tasks WHERE source_message_id IN (${placeholders(chunk)}) ORDER BY id`,
      )
      .bind(...chunk)
      .all<{ id: string; source_message_id: string }>();
    for (const t of taskRows.results)
      linked.set(t.source_message_id, [...(linked.get(t.source_message_id) ?? []), t.id]);
  }
  const resolved = await resolveRefs(db, user, caseId, stored);
  const byMessage = new Map<string, RefView[]>();
  for (const ref of stored) {
    const hit = resolved.get(refKey(ref));
    const view: RefView = {
      type: ref.type,
      id: ref.id,
      title: hit?.title ?? null,
      href: hit ? refHref(user, caseId, ref) : null,
      status: hit?.status ?? null,
    };
    byMessage.set(ref.message_id, [...(byMessage.get(ref.message_id) ?? []), view]);
  }
  return rows.map((row) =>
    toView(row, user, byMessage.get(row.id) ?? [], linked.get(row.id) ?? []),
  );
}

/** 案件の参加者だけが読める。アーカイブ済みは管理者のみ (scope の定義どおり)。 */
export async function assertCaseAccess(db: D1Database, user: AppUser, caseId: string) {
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
  return { items: await hydrate(db, user, caseId, page), hasMore };
}

// 既読位置は (last_read_at,last_read_id) の組で持ち、後戻りさせない（同じミリ秒の発言も cursor 順で区別する）。
const READ_FORWARD = `(excluded.last_read_at,excluded.last_read_id)>(last_read_at,last_read_id)`;
const ON_CONFLICT_READ = `ON CONFLICT(case_id,user_id) DO UPDATE SET
  last_read_at=CASE WHEN ${READ_FORWARD} THEN excluded.last_read_at ELSE last_read_at END,
  last_read_id=CASE WHEN ${READ_FORWARD} THEN excluded.last_read_id ELSE last_read_id END,
  updated_at=excluded.updated_at`;

const upsertRead = (
  db: D1Database,
  caseId: string,
  userId: string,
  at: string,
  messageId: string,
  now: string,
) =>
  db
    .prepare(
      `INSERT INTO case_message_reads(case_id,user_id,last_read_at,last_read_id,updated_at) VALUES (?,?,?,?,?)
    ${ON_CONFLICT_READ}`,
    )
    .bind(caseId, userId, at, messageId, now);

export async function postMessage(
  db: D1Database,
  user: AppUser,
  caseId: string,
  body: string,
  refs: readonly RefInput[] = [],
): Promise<MessageView> {
  const unique = refs.filter((r, i) => refs.findIndex((o) => refKey(o) === refKey(r)) === i);
  if (unique.length > MAX_MESSAGE_REFS)
    throw badRequest([{ field: 'refs', reason: `添付は${MAX_MESSAGE_REFS}件までです` }]);
  if (!body && unique.length === 0)
    throw badRequest([{ field: 'body', reason: '入力してください' }]);
  // 添付先は投稿者の権限で引き、範囲外・存在しないものは 404
  if (unique.length) {
    const found = await resolveRefs(db, user, caseId, unique);
    if (unique.some((r) => !found.has(refKey(r)))) throw notFound();
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO case_messages(id,case_id,sender_user_id,body_enc,created_at)
    SELECT ?,c.id,?,?,? FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope}`,
      )
      .bind(id, user.id, encryptPii(body), now, caseId, user.id),
    ...unique.map((ref, position) =>
      db
        .prepare(
          `INSERT INTO case_message_refs(message_id,position,ref_type,ref_id) SELECT id,?,?,? FROM case_messages WHERE id=?`,
        )
        .bind(position, ref.type, ref.id, id),
    ),
  ]);
  if (!inserted.meta.changes) throw notFound();
  // 自分の発言は既読として扱う
  await upsertRead(db, caseId, user.id, now, id, now).run();
  const row = await db.prepare(`${SELECT_MESSAGE} WHERE m.id=?`).bind(id).first<MessageRow>();
  if (!row) throw notFound();
  return (await hydrate(db, user, caseId, [row]))[0];
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
  if (done) {
    // 取り消したら添付も外す
    await db.prepare('DELETE FROM case_message_refs WHERE message_id=?').bind(messageId).run();
    return { caseId: done.case_id, cursor: encodeCursor(done.created_at, done.id) };
  }
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
      `INSERT INTO case_message_reads(case_id,user_id,last_read_at,last_read_id,updated_at)
    SELECT c.id,?,?,?,? FROM wedding_cases c WHERE c.id=? AND ${scope}
    ${ON_CONFLICT_READ} RETURNING case_id`,
    )
    .bind(user.id, parsed.createdAt, parsed.id, now, caseId, user.id)
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
        `SELECT c.id AS case_id,(SELECT count(*) FROM case_messages m WHERE m.case_id=c.id AND COALESCE(m.sender_user_id,m.actor_user_id,'')<>? AND m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM case_message_reads r WHERE r.case_id=c.id AND r.user_id=?
        AND (m.created_at<r.last_read_at OR (m.created_at=r.last_read_at AND m.id<=r.last_read_id)))) AS n
      FROM wedding_cases c WHERE c.id IN (${chunk.map(() => '?').join(',')}) AND ${scope}`,
      )
      .bind(user.id, user.id, ...chunk, user.id)
      .all<{ case_id: string; n: number }>();
    for (const r of results) counts[r.case_id] = r.n;
  }
  return counts;
}
