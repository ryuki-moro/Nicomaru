/**
 * PUT /api/cases/{caseId}/seating-chart — 席次の保存（#181、D1版）。
 *
 * 新郎新婦だけが保存できる。版（version）が読み込んだときと食い違えば 409、
 * 卓の条件・定員・確認済みゲストの検証は src/lib/d1/seating.ts が DB の現在値で行う。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { seatingChartSaveSchema } from '@/lib/validation';
export const PUT = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    const user = await requireRole('couple');
    const { caseId } = await context.params;
    const input = await parseBody(request, seatingChartSaveSchema);
    const { localDB } = await import('@/lib/d1/runtime');
    const { saveSeatingChart } = await import('@/lib/d1/seating');
    const version = await saveSeatingChart(await localDB(), user, caseId, input);
    return ok({ version });
  },
);
