/**
 * 案件チャットへ流すシステムメッセージ（提出・承認・期限・席次・やること作成）。
 * 発言者を持たず、文面は保存しない（messages.ts が event_type と参照から組み立てる）。
 */
import { sendChatSignal } from '@/lib/chat/notify';
import type { ChatSignal } from '@/lib/chat/ticket';
import type { D1Database } from '@cloudflare/workers-types';
import { encodeCursor, type ChatEventType, type RefInput } from './messages';

interface SystemMessageOptions {
  /** 指定すると、同じキーで流していれば何もしない（一意索引で同時実行でも1件に保つ） */
  dedupeKey?: string;
  send?: (signal: ChatSignal) => Promise<void>;
}

/**
 * システムメッセージを1件流し、開いている画面へ合図を送る。
 * 作ったときだけ true、重複で見送ったときは false。DB の失敗は投げるので、呼び出し側は
 * `announceSystemMessage` を使って本体の処理を失敗にしないこと。
 */
export async function postSystemMessage(
  db: D1Database,
  caseId: string,
  event: ChatEventType,
  refs: readonly RefInput[],
  actorUserId: string | null,
  options: SystemMessageOptions = {},
): Promise<boolean> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO case_messages(id,case_id,kind,event_type,actor_user_id,created_at,dedupe_key) VALUES (?,?,'system',?,?,?,?)
      ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      )
      .bind(id, caseId, event, actorUserId, now, options.dedupeKey ?? null),
    ...refs.map((ref, position) =>
      db
        .prepare(
          'INSERT INTO case_message_refs(message_id,position,ref_type,ref_id) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM case_messages WHERE id=?)',
        )
        .bind(id, position, ref.type, ref.id, id),
    ),
  ]);
  if (!inserted.meta.changes) return false;
  await (options.send ?? sendChatSignal)({
    type: 'message',
    caseId,
    cursor: encodeCursor(now, id),
    senderUserId: actorUserId ?? '',
  });
  return true;
}

/** 失敗しても本体の処理を失敗にしない（席次の通知と同じ扱い）。 */
export async function announceSystemMessage(
  db: D1Database,
  caseId: string,
  event: ChatEventType,
  refs: readonly RefInput[],
  actorUserId: string | null,
  options: SystemMessageOptions = {},
): Promise<void> {
  try {
    await postSystemMessage(db, caseId, event, refs, actorUserId, options);
  } catch {
    console.warn('[chat] システムメッセージを流せませんでした', event);
  }
}
