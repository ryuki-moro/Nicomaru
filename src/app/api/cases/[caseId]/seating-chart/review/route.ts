/**
 * POST /api/cases/{caseId}/seating-chart/review — 席次の承認・差し戻し（#182、D1版）。
 *
 * 承認すると席次が確定し、差し戻す（コメント必須）と新郎新婦が再び編集できる。
 * 結果はアプリ内通知で新郎新婦へ届く（src/lib/d1/seating.ts の reviewSeatingChart）。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { usingD1 } from '@/lib/d1/mode';
import { ApiError } from '@/lib/errors';
import { seatingChartReviewSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireRole('planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    const input = await parseBody(request, seatingChartReviewSchema);
    if (!usingD1()) throw new ApiError('SERVICE_UNAVAILABLE', '席次はD1でのみ利用できます');
    const { localDB } = await import('@/lib/d1/runtime');
    const { reviewSeatingChart } = await import('@/lib/d1/seating');
    return ok(await reviewSeatingChart(await localDB(), user, caseId, input));
  },
);
