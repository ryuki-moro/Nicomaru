/**
 * PATCH  /api/cases/{caseId}/guest-tags/{tagId} — 自由タグの名前を変える
 * DELETE /api/cases/{caseId}/guest-tags/{tagId} — 自由タグを消す（ゲストからも外れる）
 */
import { noContent, ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { guestTagSchema } from '@/lib/validation';
type Context = {
  params: Promise<{
    caseId: string;
    tagId: string;
  }>;
};
export const PATCH = route(async (request: Request, context: Context) => {
  const user = await requireRole('couple', 'planner', 'admin', 'system_admin');
  const { caseId, tagId } = await context.params;
  const input = await parseBody(request, guestTagSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { renameGuestTag } = await import('@/lib/d1/guests');
    return ok(await renameGuestTag(await localDB(), user, caseId, tagId, input.name));
  }
});
export const DELETE = route(async (_request: Request, context: Context) => {
  const user = await requireRole('couple', 'planner', 'admin', 'system_admin');
  const { caseId, tagId } = await context.params;
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { deleteGuestTag } = await import('@/lib/d1/guests');
    await deleteGuestTag(await localDB(), user, caseId, tagId);
    return noContent();
  }
});
