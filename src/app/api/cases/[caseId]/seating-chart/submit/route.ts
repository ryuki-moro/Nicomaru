/**
 * POST /api/cases/{caseId}/seating-chart/submit — 席次をプランナーへ提出する（#181）。
 *
 * 新郎新婦だけ。未配置の人がいる・版が古い・すでに提出済みの場合は
 * DB 関数 submit_seating_chart() が拒否する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { seatingChartSubmitSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    await requireRole('couple');
    const { caseId } = await context.params;
    const input = await parseBody(request, seatingChartSubmitSchema);
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase.rpc('submit_seating_chart', {
      p_case_id: caseId,
      p_version: input.version,
    });
    if (error) throw fromPostgresError(error);
    return ok({ version: data as number });
  },
);
