/**
 * GET/POST /api/cases/{caseId}/messages — 案件チャットの一覧・投稿。
 * 参加者の判定とロールの扱いは D1 層（messages.ts）が持つ。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { sendChatSignal } from '@/lib/chat/notify';
import { isStaff, RATE_LIMITS } from '@/lib/constants';
import { userRateLimit } from '@/lib/d1/auth-limits';
import { notifyCouplesOfStaffMessage } from '@/lib/d1/chat-notifications';
import { listMessages, postMessage } from '@/lib/d1/messages';
import { localDB } from '@/lib/d1/runtime';
import { badRequest, notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import { chatMessageSchema } from '@/lib/validation';

const PAGE_LIMIT = 50;

/** limit は丸めず、範囲外は 400。after / before のカーソル検証は D1 層が行う。 */
function readQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null || rawLimit === '' ? PAGE_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) {
    throw badRequest([
      { field: 'limit', reason: `1以上${PAGE_LIMIT}以下の整数を指定してください` },
    ]);
  }
  return {
    limit,
    after: params.get('after') ?? undefined,
    before: params.get('before') ?? undefined,
  };
}

export const GET = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireAppUser();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) throw notFound();
    return ok(await listMessages(await localDB(), user, caseId, readQuery(request)));
  },
);

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireAppUser();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) throw notFound();
    const { body } = await parseBody(request, chatMessageSchema);
    const db = await localDB();
    await userRateLimit(db, 'chat_post', user.id, RATE_LIMITS.chatPost);
    const message = await postMessage(db, user, caseId, body);
    await sendChatSignal({
      type: 'message',
      caseId,
      cursor: message.cursor,
      senderUserId: user.id,
    });
    if (isStaff(user.role)) {
      // 通知の失敗で投稿を失敗にしない
      try {
        await notifyCouplesOfStaffMessage(db, user, caseId);
      } catch {
        console.warn('[chat] 新着通知を作成できませんでした');
      }
    }
    return ok(message, 201);
  },
);
