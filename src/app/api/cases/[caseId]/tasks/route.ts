/**
 * POST /api/cases/{caseId}/tasks … 案件に個別宿題を追加（機能5-5、K02 宿題一覧セクション）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-5 表6-6。
 *
 * 入力項目は T02（表4-17）と同一だが、逆算日数ではなく期限（日付）を直接指定し、
 * task_template_id は NULL、display_order は既存の最大値+1 とする。
 * case_tasks と timeline_items の2テーブルへ書くため、DB側の add_case_task() へ集約する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError, notFound } from '@/lib/errors';
import { phaseNameFor } from '@/lib/services/schedule';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { caseTaskCreateSchema } from '@/lib/validation';

export const POST = route(async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
  await requireRole('planner', 'admin', 'system_admin');
  const { caseId } = await context.params;
  const input = await parseBody(request, caseTaskCreateSchema);
  const supabase = await createSupabaseServerClient();

  // タイムラインの見出し（phase_name）は挙式日からの距離で決まる（表5-14）
  const { data: caseData, error: caseError } = await supabase
    .from('wedding_cases')
    .select('id, wedding_date')
    .eq('id', caseId)
    .maybeSingle();
  if (caseError) throw fromPostgresError(caseError);
  if (!caseData) throw notFound('案件が見つかりません');
  const target = caseData as { wedding_date: string };

  const { data, error } = await supabase.rpc('add_case_task', {
    p_case_id: caseId,
    p_task: {
      title: input.title,
      description: input.description ?? null,
      submission_format: input.submissionFormat,
      allowed_file_types: input.allowedFileTypes,
      options: input.options,
      is_required: input.isRequired,
      importance: input.importance,
      due_date: input.dueDate,
      phase_name: phaseNameFor(target.wedding_date, input.dueDate),
    },
  });
  if (error) throw fromPostgresError(error);

  const created = data as { id: string; display_order: number };
  return ok({ id: created.id, displayOrder: created.display_order }, 201);
});
