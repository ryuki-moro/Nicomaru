/**
 * /api/cases/{caseId}/seating-layouts/{layoutId} — 配置パターンの更新・送付・削除（#180、D1版）。
 *
 *   PUT    卓を含めてまとめて置き換える（卓の ID は保たれる）
 *   PATCH  新郎新婦へ送る／送るのをやめる（offered）
 *   DELETE 配置パターンを消す（その卓の割り当ては未配置に戻る）
 */
import { noContent, ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { seatingLayoutOfferSchema, seatingLayoutSchema } from '@/lib/validation';
type Context = {
  params: Promise<{
    caseId: string;
    layoutId: string;
  }>;
};
const d1Only = () => {};
export const PUT = route(async (request: Request, context: Context) => {
  const user = await requireRole('planner', 'admin', 'system_admin');
  const { caseId, layoutId } = await context.params;
  const input = await parseBody(request, seatingLayoutSchema);
  d1Only();
  const { localDB } = await import('@/lib/d1/runtime');
  const { loadSeatingLayouts, saveSeatingLayout } = await import('@/lib/d1/seating');
  const db = await localDB();
  const id = await saveSeatingLayout(db, user, caseId, layoutId, input);
  return ok({ id, layouts: await loadSeatingLayouts(db, user, caseId) });
});
export const PATCH = route(async (request: Request, context: Context) => {
  const user = await requireRole('planner', 'admin', 'system_admin');
  const { layoutId } = await context.params;
  const input = await parseBody(request, seatingLayoutOfferSchema);
  d1Only();
  const { localDB } = await import('@/lib/d1/runtime');
  const { setSeatingLayoutOffered } = await import('@/lib/d1/seating');
  await setSeatingLayoutOffered(await localDB(), user, layoutId, input.offered);
  return noContent();
});
export const DELETE = route(async (_request: Request, context: Context) => {
  const user = await requireRole('planner', 'admin', 'system_admin');
  const { layoutId } = await context.params;
  d1Only();
  const { localDB } = await import('@/lib/d1/runtime');
  const { deleteSeatingLayout } = await import('@/lib/d1/seating');
  await deleteSeatingLayout(await localDB(), user, layoutId);
  return noContent();
});
