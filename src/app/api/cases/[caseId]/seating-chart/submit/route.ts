/**
 * POST /api/cases/{caseId}/seating-chart/submit — 席次の提出（#181、D1版）。
 *
 * 全員の席が決まっていることと、保存済みの割り当てが条件・定員に合うことを
 * src/lib/d1/seating.ts が確かめてから提出済みにする。提出はプランナーへ通知する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { usingD1 } from '@/lib/d1/mode';
import { ApiError } from '@/lib/errors';
import { seatingChartSubmitSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const user = await requireRole('couple');
    const { caseId } = await context.params;
    const input = await parseBody(request, seatingChartSubmitSchema);
    if (!usingD1()) throw new ApiError('SERVICE_UNAVAILABLE', '席次はD1でのみ利用できます');
    const { localDB } = await import('@/lib/d1/runtime');
    const { submitSeatingChart } = await import('@/lib/d1/seating');
    const version = await submitSeatingChart(await localDB(), user, caseId, input.version);
    return ok({ version, status: 'submitted' });
  },
);
