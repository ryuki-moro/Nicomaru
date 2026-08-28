/**
 * プラン種別に紐づく宿題テンプレートの読み出し。
 *
 * 正本: 基本設計書 Version 1.2 6-6-2「宿題一括割当とトランザクション境界」／T02。
 *
 * 【なぜ Route Handler ではなくここに置くか】
 * この読み出しは K04 の差分確認（PATCH /api/cases/{caseId}）と
 * 宿題一括割当（POST /api/cases/{caseId}/assign-tasks）の両方が使う。
 * Route Handler ファイルが export できるのは HTTPメソッドなど所定の名前だけだが、
 * src/lib/ の共有モジュールを import することは妨げられない。
 * 写して持つと「差分確認ダイアログで見せたテンプレート集合」と
 * 「実際に割り当てる集合」がずれても誰も気づけないため、実装をここ1つに閉じる。
 */
import type { Importance, SubmissionFormat } from '@/lib/constants';
import { fromPostgresError } from '@/lib/errors';
import type { TemplateForAssign } from '@/lib/services/schedule';
import type { SupabaseServerClient } from '@/lib/supabase/server';

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

const PLAN_TEMPLATE_SELECT =
  `display_order, is_required, due_offset_days_override,
   task_templates ( id, name, description, submission_format, allowed_file_types,
                    default_options, due_offset_days, importance, active )`;

/**
 * プラン種別に紐づく宿題テンプレートを、割当・差分計算で使う形（TemplateForAssign）へ写す。
 * 並びは plan_task_templates.display_order 昇順（画面の宿題の並びと一致させる）。
 */
export async function loadPlanTemplates(
  supabase: SupabaseServerClient,
  planTypeId: string,
): Promise<TemplateForAssign[]> {
  const { data, error } = await supabase
    .from('plan_task_templates')
    .select(PLAN_TEMPLATE_SELECT)
    .eq('plan_type_id', planTypeId)
    .order('display_order', { ascending: true });
  if (error) throw fromPostgresError(error);

  return ((data ?? []) as unknown as PlanTemplateRow[])
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
        // プラン固有の上書きがあればそちらを使う（6-6-2）
        dueOffsetDaysOverride: row.due_offset_days_override,
        isRequired: row.is_required,
        displayOrder: row.display_order,
      };
    });
}
