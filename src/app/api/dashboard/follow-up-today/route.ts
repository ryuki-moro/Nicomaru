import { ok, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { dashboard } from '@/lib/d1/dashboard';
import { localDB } from '@/lib/d1/runtime';
export const GET = route(async () => {
  const user = await requireStaff();
  return ok({ items: (await dashboard(await localDB(), user)).followUps.slice(0, 20) });
});
