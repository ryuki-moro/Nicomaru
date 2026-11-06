/** S02 式場編集。式場コードと管理者アカウントはこのAPIでは変更しない。 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { notFound } from '@/lib/errors';
import { venueUpdateSchema } from '@/lib/validation';
import { z } from 'zod';
type RouteContext = {
  params: Promise<{
    venueId: string;
  }>;
};
export const PATCH = route<[RouteContext]>(async (request, context) => {
  const actor = await requireRole('system_admin');
  const { venueId } = await context.params;
  if (!z.string().uuid().safeParse(venueId).success) throw notFound('式場が見つかりません');
  const input = await parseBody(request, venueUpdateSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { updateVenueD1 } = await import('@/lib/d1/admin');
    return ok(await updateVenueD1(await localDB(), actor, venueId, input));
  }
});
