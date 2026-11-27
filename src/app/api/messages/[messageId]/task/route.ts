/**
 * POST /api/messages/{messageId}/task — チャットのメッセージから、やることを作る（スタッフのみ）。
 * 入力は POST /api/cases/{caseId}/tasks と同じ。新郎新婦には存在を明かさず 404 を返す。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { isStaff } from '@/lib/constants';
import { createTaskFromMessage } from '@/lib/d1/message-tasks';
import { localDB } from '@/lib/d1/runtime';
import { notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import { caseTaskCreateSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ messageId: string }> }) => {
    const user = await requireAppUser();
    const { messageId } = await context.params;
    if (!isUuid(messageId) || !isStaff(user.role)) throw notFound();
    const input = await parseBody(request, caseTaskCreateSchema);
    return ok(await createTaskFromMessage(await localDB(), user, messageId, input), 201);
  },
);
