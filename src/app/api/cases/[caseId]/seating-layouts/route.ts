/**
 * POST /api/cases/{caseId}/seating-layouts — 卓の配置パターンを新しく作る（#180、D1版）。
 *
 * 書き込みの規則（担当スタッフだけ・アーカイブ済みは不可・卓の ID の保持）は
 * src/lib/d1/seating.ts の saveSeatingLayout が担う。保存後の配置一覧をそのまま返す。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { usingD1 } from '@/lib/d1/mode';
import { ApiError } from '@/lib/errors';
import { seatingLayoutSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireRole('planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    const input = await parseBody(request, seatingLayoutSchema);
    if (!usingD1()) throw new ApiError('SERVICE_UNAVAILABLE', '席次はD1でのみ利用できます');
    const { localDB } = await import('@/lib/d1/runtime');
    const { loadSeatingLayouts, saveSeatingLayout } = await import('@/lib/d1/seating');
    const db = await localDB();
    const id = await saveSeatingLayout(db, user, caseId, null, input);
    return ok({ id, layouts: await loadSeatingLayouts(db, user, caseId) }, 201);
  },
);
