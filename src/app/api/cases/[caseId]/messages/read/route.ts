/** POST /api/cases/{caseId}/messages/read — 既読位置の更新。 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { requireAppUser } from '@/lib/auth/session';
import { markRead } from '@/lib/d1/messages';
import { localDB } from '@/lib/d1/runtime';
import { notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import { chatReadSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireAppUser();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) throw notFound();
    const { cursor } = await parseBody(request, chatReadSchema);
    await markRead(await localDB(), user, caseId, cursor);
    return noContent();
  },
);
