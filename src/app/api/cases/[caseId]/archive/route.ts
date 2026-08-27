/**
 * POST /api/cases/{caseId}/archive … 案件の論理削除（K05）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K05／5-1「削除方針」／6-5 表6-6。
 *
 * 物理削除は行わない。status='archived' と archived_at のみを記録し、
 * アーカイブ済み案件は K01 の表示範囲フィルタから admin が参照・復元できる（機能2-6）。
 * 復元は PATCH /api/cases/{caseId} に archived:false を渡す（同じ RPC の逆方向）。
 */
import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const POST = route(async (_request: Request, context: { params: Promise<{ caseId: string }> }) => {
  // K05 は admin のみ（4-1 表4-10）。DB側 apply_case_update でもロールを再検証する。
  await requireRole('admin', 'system_admin');
  const { caseId } = await context.params;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('apply_case_update', {
    p_case_id: caseId,
    p_patch: { archived: true },
    p_profiles: {},
    p_due_changes: [],
    p_waived_task_ids: null,
    p_new_tasks: [],
  });
  if (error) throw fromPostgresError(error);

  return ok({ archived: true });
});
