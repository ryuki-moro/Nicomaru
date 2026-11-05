/**
 * POST /api/cases/{caseId}/seating-layouts — 卓の配置パターンを作る（#180）。
 *
 * 担当プランナー・admin だけ。書き込みは DB 関数 save_seating_layout() が権限と業務ルール
 * （アーカイブ済み・卓数・パターン数の上限）を検査する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { seatingLayoutSchema } from '@/lib/validation';

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    await requireRole('planner', 'admin', 'system_admin');
    const { caseId } = await context.params;
    const input = await parseBody(request, seatingLayoutSchema);
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase.rpc('save_seating_layout', {
      p_case_id: caseId,
      p_layout_id: null,
      p_name: input.name,
      p_hall_shape: input.hallShape,
      p_tables: input.tables,
    });
    if (error) throw fromPostgresError(error);
    return ok({ id: data as string }, 201);
  },
);
