/**
 * PUT /api/cases/{caseId}/seating-chart — 席次を下書きとして保存する（#181）。
 *
 * 新郎新婦だけ。選んだ配置パターンと、ゲストごとの卓・席順をまとめて送る（送らなかった人は未配置）。
 * 権限・アーカイブ済み・提出済み・卓の条件と定員・版の食い違いは DB 関数 save_seating_chart() が検査する。
 * 版が古いとき（もう一人が先に保存した）は 409 になる。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { seatingChartSaveSchema } from '@/lib/validation';

export const PUT = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    await requireRole('couple');
    const { caseId } = await context.params;
    const input = await parseBody(request, seatingChartSaveSchema);
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase.rpc('save_seating_chart', {
      p_case_id: caseId,
      p_layout_id: input.layoutId,
      p_version: input.version,
      p_assignments: input.assignments,
    });
    if (error) throw fromPostgresError(error);
    return ok({ version: data as number });
  },
);
