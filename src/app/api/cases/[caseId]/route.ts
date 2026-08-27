/**
 * GET   /api/cases/{caseId} … 案件詳細の取得
 * PATCH /api/cases/{caseId} … 案件更新（K04。担当プランナー変更・アーカイブ解除を含む）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K04／6-5 表6-6／6-6-2「宿題一括割当とトランザクション境界」。
 *
 * 【差分確認ダイアログの往復（4-3 K04）】
 * 挙式日またはプラン種別を変更した場合は、確定前に差分（期限が変わる宿題・追加される宿題・
 * waived になる宿題）を提示し、プランナーの承認操作を経て適用する。
 * そのため本APIは confirmed:true を受け取るまで書き込みを行わず、プレビューだけを返す。
 * 「提示した内容」と「適用する内容」を必ず一致させるため、再計算はサービス層
 * （schedule.ts）で1度だけ行い、その結果をそのまま apply_case_update() へ渡す。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import {
  COUPLE_PROFILE_COLUMNS,
  INCOMPLETE_TASK_STATUSES,
  type Importance,
  type SubmissionFormat,
  type TaskStatus,
} from '@/lib/constants';
import { decryptPii, emailHash, encryptPii } from '@/lib/crypto';
import { badRequest, forbidden, fromPostgresError, notFound } from '@/lib/errors';
import {
  phaseNameFor,
  planTasks,
  previewPlanChange,
  recalculateDueDates,
  type ExistingTask,
  type TemplateForAssign,
} from '@/lib/services/schedule';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { casePatchSchema } from '@/lib/validation';

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

interface CaseDetailRow {
  id: string;
  case_code: string;
  venue_id: string;
  plan_type_id: string | null;
  primary_planner_id: string;
  wedding_date: string;
  wedding_time: string | null;
  contact_channel: string;
  status: string;
  guest_count: number | null;
  venue_room: string | null;
  notes: string | null;
  archived_at: string | null;
  plan_types: { id: string; name: string } | null;
  user_profiles: { id: string; display_name: string } | null;
  couple_profiles: {
    partner_role: string;
    full_name: string;
    email: string | null;
    is_primary_contact: boolean;
  }[];
}

const CASE_DETAIL_SELECT =
  `id, case_code, venue_id, plan_type_id, primary_planner_id, wedding_date, wedding_time,
   contact_channel, status, guest_count, venue_room, notes, archived_at,
   plan_types ( id, name ),
   user_profiles ( id, display_name ),
   couple_profiles ( ${COUPLE_PROFILE_COLUMNS} )`;

export const GET = route(async (_request: Request, context: { params: Promise<{ caseId: string }> }) => {
  await requireStaff();
  const { caseId } = await context.params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('wedding_cases')
    .select(CASE_DETAIL_SELECT)
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw notFound('案件が見つかりません');

  const row = data as unknown as CaseDetailRow;

  const { data: taskRows, error: taskError } = await supabase
    .from('case_tasks')
    .select('id, title, status, due_date, importance, display_order')
    .eq('case_id', caseId)
    // 一覧の既定並び順は ORDER BY due_date, display_order, id（4-3／定数 TASK_ORDER と同一）
    .order('due_date', { ascending: true })
    .order('display_order', { ascending: true })
    .order('id', { ascending: true });
  if (taskError) throw fromPostgresError(taskError);

  const tasks = (taskRows ?? []) as { status: TaskStatus }[];
  const incomplete = tasks.filter((t) => INCOMPLETE_TASK_STATUSES.includes(t.status)).length;

  return ok({
    id: row.id,
    caseCode: row.case_code,
    weddingDate: row.wedding_date,
    weddingTime: row.wedding_time,
    contactChannel: row.contact_channel,
    status: row.status,
    guestCount: row.guest_count,
    venueRoom: row.venue_room,
    notes: row.notes,
    archivedAt: row.archived_at,
    planType: row.plan_types,
    primaryPlanner: row.user_profiles,
    partners: row.couple_profiles.map((profile) => ({
      partnerRole: profile.partner_role,
      // 暗号化列は参照時に復号する（13-1）
      fullName: decryptPii(profile.full_name) ?? '',
      email: decryptPii(profile.email),
      isPrimaryContact: profile.is_primary_contact,
    })),
    taskTotal: tasks.length,
    taskDone: tasks.length - incomplete,
  });
});

// ------------------------------------------------------------------- K04 の更新
interface ExistingTaskRow {
  id: string;
  task_template_id: string | null;
  title: string;
  status: TaskStatus;
  due_date: string;
  task_templates: { due_offset_days: number } | null;
}

/**
 * プラン種別に紐づく宿題テンプレートを TemplateForAssign へ写す。
 * assign-tasks の Route Handler にも同じ読み出しがあるが、Route Handler は
 * HTTPメソッド以外の値を export できないため共有できない（Next.js の型検査で落ちる）。
 * 変更するときは src/app/api/cases/[caseId]/assign-tasks/route.ts も併せて直すこと。
 */
async function loadPlanTemplates(
  supabase: SupabaseServerClient,
  planTypeId: string,
): Promise<TemplateForAssign[]> {
  const { data, error } = await supabase
    .from('plan_task_templates')
    .select(
      `display_order, is_required, due_offset_days_override,
       task_templates ( id, name, description, submission_format, allowed_file_types,
                        default_options, due_offset_days, importance, active )`,
    )
    .eq('plan_type_id', planTypeId)
    .order('display_order', { ascending: true });
  if (error) throw fromPostgresError(error);

  const rows = (data ?? []) as unknown as {
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
  }[];

  return rows
    // 無効化したテンプレートは新規割当に含めない（T02 の active）
    .filter((row) => row.task_templates !== null && row.task_templates.active)
    .map((row) => {
      const template = row.task_templates as NonNullable<typeof row.task_templates>;
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

export const PATCH = route(async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
  const actor = await requireStaff();
  const { caseId } = await context.params;
  const input = await parseBody(request, casePatchSchema);
  const supabase = await createSupabaseServerClient();

  // アーカイブ／復元（K05／K01「復元する」）は admin のみ。
  // 他項目と同時に送られた場合、片方だけ適用されると画面の表示と実データが食い違うため弾く。
  if (input.archived !== undefined) {
    if (actor.role !== 'admin' && actor.role !== 'system_admin') throw forbidden();
    const others = Object.keys(input).filter((key) => key !== 'archived' && key !== 'confirmed');
    if (others.length > 0) {
      throw badRequest([
        { field: 'archived', reason: 'アーカイブの切り替えは他の項目と同時に変更できません' },
      ]);
    }
    const { error } = await supabase.rpc('apply_case_update', {
      p_case_id: caseId,
      p_patch: { archived: input.archived },
      p_profiles: {},
      p_due_changes: [],
      p_waived_task_ids: null,
      p_new_tasks: [],
    });
    if (error) throw fromPostgresError(error);
    return ok({ applied: true });
  }

  const { data: currentRow, error: currentError } = await supabase
    .from('wedding_cases')
    .select('id, wedding_date, plan_type_id')
    .eq('id', caseId)
    .maybeSingle();
  if (currentError) throw fromPostgresError(currentError);
  if (!currentRow) throw notFound('案件が見つかりません');
  const current = currentRow as { id: string; wedding_date: string; plan_type_id: string | null };

  const weddingDate = input.weddingDate ?? current.wedding_date;
  const planTypeId = input.planTypeId ?? current.plan_type_id;
  const weddingDateChanged = input.weddingDate !== undefined && input.weddingDate !== current.wedding_date;
  const planChanged = input.planTypeId !== undefined && input.planTypeId !== current.plan_type_id;

  let dueChanges: { id: string; title: string; from: string; to: string }[] = [];
  let waived: { id: string; title: string }[] = [];
  let added: { taskTemplateId: string; title: string; dueDate: string }[] = [];
  let newTasks: ReturnType<typeof planTasks> = [];

  if ((weddingDateChanged || planChanged) && planTypeId) {
    const { data: taskData, error: taskError } = await supabase
      .from('case_tasks')
      .select('id, task_template_id, title, status, due_date, task_templates ( due_offset_days )')
      .eq('case_id', caseId);
    if (taskError) throw fromPostgresError(taskError);
    const taskRows = (taskData ?? []) as unknown as ExistingTaskRow[];

    const templates = await loadPlanTemplates(supabase, planTypeId);
    const offsetByTemplate = new Map(
      templates.map((t) => [t.taskTemplateId, t.dueOffsetDaysOverride ?? t.dueOffsetDays]),
    );

    // 逆算日数は「新しいプランの上書き値 → テンプレート本体の値」の順で解決する。
    // 個別追加の宿題（task_template_id が NULL）は逆算日数を持たないため再計算対象外（6-6-2）。
    const existing: ExistingTask[] = taskRows.map((row) => ({
      id: row.id,
      taskTemplateId: row.task_template_id,
      title: row.title,
      status: row.status,
      dueDate: row.due_date,
      dueOffsetDays:
        row.task_template_id === null
          ? null
          : offsetByTemplate.get(row.task_template_id) ?? row.task_templates?.due_offset_days ?? null,
    }));

    if (planChanged) {
      const preview = previewPlanChange(weddingDate, existing, templates);
      waived = preview.waived;
      added = preview.added;
      newTasks = planTasks(
        weddingDate,
        templates,
        existing.map((t) => t.taskTemplateId).filter((id): id is string => id !== null),
      );
    }

    if (weddingDateChanged) {
      const waivedIds = new Set(waived.map((w) => w.id));
      // waived にする宿題の期限を動かしても意味が無いので、差分の提示からも外す
      dueChanges = recalculateDueDates(weddingDate, existing).filter((c) => !waivedIds.has(c.id));
    }
  }

  const needsConfirmation = dueChanges.length > 0 || waived.length > 0 || added.length > 0;

  // 差分がある変更は confirmed:true を受け取るまで書き込まない（4-3 K04）
  if (needsConfirmation && input.confirmed !== true) {
    return ok({
      applied: false,
      preview: { weddingDate, planChanged, dueChanges, waived, added },
    });
  }

  const patch: Record<string, unknown> = {};
  if (input.weddingDate !== undefined) patch.wedding_date = input.weddingDate;
  if (input.weddingTime !== undefined) patch.wedding_time = input.weddingTime;
  if (input.planTypeId !== undefined) patch.plan_type_id = input.planTypeId;
  if (input.contactChannel !== undefined) patch.contact_channel = input.contactChannel;
  if (input.guestCount !== undefined) patch.guest_count = input.guestCount;
  if (input.venueRoom !== undefined) patch.venue_room = input.venueRoom;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.primaryPlannerId !== undefined) patch.primary_planner_id = input.primaryPlannerId;

  // 氏名・連絡先メールは暗号化して渡す。復号鍵はサーバー側にのみ置く（13-1）
  const profiles: Record<string, unknown> = {};
  if (input.groomName !== undefined) profiles.groom_name_enc = encryptPii(input.groomName);
  if (input.brideName !== undefined) profiles.bride_name_enc = encryptPii(input.brideName);
  if (input.primaryContact !== undefined) profiles.primary_contact = input.primaryContact;
  if (input.contactEmail !== undefined) {
    profiles.contact_email_enc = encryptPii(input.contactEmail);
    profiles.contact_email_hash = emailHash(input.contactEmail);
  }

  const { data, error } = await supabase.rpc('apply_case_update', {
    p_case_id: caseId,
    p_patch: patch,
    p_profiles: profiles,
    p_due_changes: dueChanges.map((change) => ({
      id: change.id,
      due_date: change.to,
      phase_name: phaseNameFor(weddingDate, change.to),
    })),
    p_waived_task_ids: waived.length > 0 ? waived.map((w) => w.id) : null,
    p_new_tasks: newTasks.map((task) => ({
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
      phase_name: phaseNameFor(weddingDate, task.dueDate),
    })),
  });
  if (error) throw fromPostgresError(error);

  const result = (data ?? { due_changed: 0, waived: 0, added: 0 }) as {
    due_changed: number;
    waived: number;
    added: number;
  };
  return ok({ applied: true, dueChanged: result.due_changed, waived: result.waived, added: result.added });
});
