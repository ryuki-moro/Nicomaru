/**
 * PATCH /api/cases/{caseId}/tasks/{taskId}
 *   宿題の期限変更・対応不要（waived）付与・タイトル／説明の変更（機能5-5、K02）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-5 表6-6／表6-9。
 *
 * case_tasks と対応する timeline_items を同時に更新しないと、マイページ（M04）に
 * 古い期限が残る。2テーブルを1トランザクションで揃えるため update_case_task() へ集約する。
 * waived（DB値）は表6-9 により画面上は「対応不要」と表示する。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { badRequest, fromPostgresError, notFound } from '@/lib/errors';
import { phaseNameFor } from '@/lib/services/schedule';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { caseTaskUpdateSchema } from '@/lib/validation';

export const PATCH = route(
  async (request: Request, context: { params: Promise<{ caseId: string; taskId: string }> }) => {
    await requireRole('planner', 'admin', 'system_admin');
    const { caseId, taskId } = await context.params;
    const input = await parseBody(request, caseTaskUpdateSchema);
    const supabase = await createSupabaseServerClient();

    if (Object.keys(input).length === 0) {
      throw badRequest([{ field: '_', reason: '変更する項目がありません' }]);
    }

    // URL の caseId と実データの整合を確認する（他案件の宿題IDを渡させない）
    const { data: taskData, error: taskError } = await supabase
      .from('case_tasks')
      .select('id, case_id, wedding_cases ( wedding_date )')
      .eq('id', taskId)
      .eq('case_id', caseId)
      .maybeSingle();
    if (taskError) throw fromPostgresError(taskError);
    if (!taskData) throw notFound('宿題が見つかりません');
    const task = taskData as unknown as { wedding_cases: { wedding_date: string } | null };

    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.waived !== undefined) patch.waived = input.waived;
    if (input.dueDate !== undefined) {
      patch.due_date = input.dueDate;
      // 期限が動けばタイムラインの見出しも変わる（表5-14 phase_name）
      if (task.wedding_cases) {
        patch.phase_name = phaseNameFor(task.wedding_cases.wedding_date, input.dueDate);
      }
    }

    const { error } = await supabase.rpc('update_case_task', {
      p_case_task_id: taskId,
      p_patch: patch,
    });
    if (error) throw fromPostgresError(error);

    return noContent();
  },
);
