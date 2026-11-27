/** DELETE /api/messages/{messageId} — 送信者本人による取り消し（時間制限は D1 層）。 */
import { ok, route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { sendChatSignal } from '@/lib/chat/notify';
import { retractMessage } from '@/lib/d1/messages';
import { localDB } from '@/lib/d1/runtime';
import { notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';

export const DELETE = route(
  async (_request: Request, context: { params: Promise<{ messageId: string }> }) => {
    const user = await requireAppUser();
    const { messageId } = await context.params;
    if (!isUuid(messageId)) throw notFound();
    const { caseId, cursor } = await retractMessage(await localDB(), user, messageId);
    await sendChatSignal({ type: 'retract', caseId, cursor, senderUserId: user.id });
    return ok({ retracted: true });
  },
);
