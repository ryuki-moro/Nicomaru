/**
 * POST /api/cases/{caseId}/messages/ticket — チャットWorkerへの WebSocket 接続チケットを発行する。
 * 未構成の環境では 503 CHAT_UNAVAILABLE を返し、クライアントは定期取得へ切り替える。
 */
import { ok, route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { signTicket, TICKET_TTL_SEC } from '@/lib/chat/ticket';
import { assertCaseAccess } from '@/lib/d1/messages';
import { localDB } from '@/lib/d1/runtime';
import { ApiError, notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';

export const POST = route(
  async (_request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireAppUser();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) throw notFound();
    await assertCaseAccess(await localDB(), user, caseId);
    const wsUrl = process.env.CHAT_WS_URL;
    const secret = process.env.CHAT_TICKET_SECRET;
    if (!wsUrl || !secret) throw new ApiError('CHAT_UNAVAILABLE');
    const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
    const ticket = await signTicket(secret, { caseId, userId: user.id, exp });
    return ok({ url: `${wsUrl}?ticket=${ticket}`, expiresIn: TICKET_TTL_SEC });
  },
);
