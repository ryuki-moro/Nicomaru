/**
 * POST /api/cases/{caseId}/assign-tasks
 *   プラン種別テンプレートから宿題を一括割当し、タイムラインも同一トランザクションで生成する。
 *
 * 正本: 基本設計書 Version 1.2 6-5 表6-6／6-6-2「宿題一括割当とトランザクション境界」。
 *
 * 【なぜ案件登録と別APIなのか】
 * 6-6-2 で「案件登録（/api/cases）と宿題一括割当・タイムライン生成の2つのAPIで構成する」と確定している。
 * API呼び出しをまたぐ範囲（案件は登録済みだが宿題未割当）は正常に起こり得る状態として扱い、
 * プランナー画面から再度呼び出せる。再実行時は未割当のテンプレート分のみを追加し、
 * 既存 case_tasks は変更しない（エラーにはしない）。応答は追加件数で、0件でも 200 を返す。
 *
 * 自動リトライは行わない（二重作成回避）。失敗時はエラーを返し、画面側で再実行を促す。
 */
import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import type { Importance, SubmissionFormat } from '@/lib/constants';
import { fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { phaseNameFor, planTasks, type TemplateForAssign } from '@/lib/services/schedule';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface PlanTemplateRow {
  display_order: number;
  is_required: boolean;
  due_offset_days_override: number | null;
  task_templates: {
    id: string;
    name: string;
    description: string | null;
    submission_format: SubmissionFormat;
    allowed_file_types: string[];
    default_options: Record<string, unknown>;
    due_offset_days: number;
    importance: Importance;
    active: boolean;
  } | null;
}

export const POST = route(async (_request: Request, context: { params: Promise<{ caseId: string }> }) => {
  await requireRole('planner', 'admin', 'system_admin');
  const { caseId } = await context.params;
  const supabase = await createSupabaseServerClient();

  const { data: caseData, error: caseError } = await supabase
    .from('wedding_cases')
    .select('id, wedding_date, plan_type_id')
    .eq('id', caseId)
    .maybeSingle();
  if (caseError) throw fromPostgresError(caseError);
  if (!caseData) throw notFound('案件が見つかりません');
  const target = caseData as { id: string; wedding_date: string; plan_type_id: string | null };

  if (!target.plan_type_id) {
    // プラン種別が未設定（プラン削除で NULL 化された等）では割り当てるテンプレートが決まらない
    throw unprocessable('プラン種別が設定されていないため、宿題を割り当てられません');
  }

  // 同じ読み出しが src/app/api/cases/[caseId]/route.ts（K04 の差分計算）にもある。
  // Route Handler は HTTPメソッド以外を export できず共有できないため、変更時は両方直すこと。
  const { data: templateData, error: templateError } = await supabase
    .from('plan_task_templates')
    .select(
      `display_order, is_required, due_offset_days_override,
       task_templates ( id, name, description, submission_format, allowed_file_types,
                        default_options, due_offset_days, importance, active )`,
    )
    .eq('plan_type_id', target.plan_type_id)
    .order('display_order', { ascending: true });
  if (templateError) throw fromPostgresError(templateError);

  const templates: TemplateForAssign[] = ((templateData ?? []) as unknown as PlanTemplateRow[])
    // 無効化したテンプレートは新規割当に含めない（T02 の active）
    .filter((row) => row.task_templates !== null && row.task_templates.active)
    .map((row) => {
      const template = row.task_templates as NonNullable<PlanTemplateRow['task_templates']>;
      return {
        taskTemplateId: template.id,
        title: template.name,
        description: template.description,
        submissionFormat: template.submission_format,
        allowedFileTypes: template.allowed_file_types ?? [],
        options: template.default_options ?? {},
        importance: template.importance,
        dueOffsetDays: template.due_offset_days,
        dueOffsetDaysOverride: row.due_offset_days_override,
        isRequired: row.is_required,
        displayOrder: row.display_order,
      };
    });

  // 既に割り当て済みのテンプレートを除くのはサービス層とDB側の二重判定。
  // 二重呼び出しが同時に届いた場合の取りこぼしはDB側（assign_case_tasks）が受け止める。
  const { data: assignedData, error: assignedError } = await supabase
    .from('case_tasks')
    .select('task_template_id')
    .eq('case_id', caseId)
    .not('task_template_id', 'is', null);
  if (assignedError) throw fromPostgresError(assignedError);
  const assigned = ((assignedData ?? []) as { task_template_id: string | null }[])
    .map((row) => row.task_template_id)
    .filter((id): id is string => id !== null);

  const planned = planTasks(target.wedding_date, templates, assigned);

  const { data, error } = await supabase.rpc('assign_case_tasks', {
    p_case_id: caseId,
    p_tasks: planned.map((task) => ({
      task_template_id: task.taskTemplateId,
      title: task.title,
      description: task.description,
      submission_format: task.submissionFormat,
      allowed_file_types: task.allowedFileTypes,
      options: task.options,
      is_required: task.isRequired,
      importance: task.importance,
      due_date: task.dueDate,
      display_order: task.displayOrder,
      // タイムラインの見出し（表5-14 phase_name）。判定はサービス層に一本化する
      phase_name: phaseNameFor(target.wedding_date, task.dueDate),
    })),
  });
  if (error) throw fromPostgresError(error);

  return ok({ added: (data as number | null) ?? 0 });
});
