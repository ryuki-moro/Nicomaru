'use server';

import { revalidatePath } from 'next/cache';

import { requirePageUser } from '@/lib/auth/session';
import { TASK_STATUS_LABEL } from '@/lib/constants';
import { formatDate } from '@/lib/format';
import { loadMeetingSheet } from '@/lib/services/meeting-sheets';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface SheetActionState {
  status: 'idle' | 'success' | 'error';
  message: string;
}

export async function recordSheet(
  _previous: SheetActionState,
  formData: FormData,
): Promise<SheetActionState> {
  const actor = await requirePageUser('planner', 'admin', 'system_admin');
  const caseId = String(formData.get('caseId') ?? '');
  try {
    const supabase = await createSupabaseServerClient();
    const { summary } = await loadMeetingSheet(supabase, caseId);
    const { error } = await supabase.from('meeting_sheets').insert({
      case_id: caseId,
      generated_by: actor.id,
      summary_json: summary,
    });
    if (error)
      return {
        status: 'error',
        message: '記録できませんでした。時間をおいてもう一度お試しください。',
      };
  } catch {
    return {
      status: 'error',
      message: '情報を読み込めなかったため記録していません。画面を開き直してください。',
    };
  }
  revalidatePath(`/cases/${caseId}/sheet`);
  return { status: 'success', message: '最新の内容を記録しました。' };
}

export async function requestSheetDraft(
  _previous: SheetActionState,
  formData: FormData,
): Promise<SheetActionState> {
  await requirePageUser('planner', 'admin', 'system_admin');
  const caseId = String(formData.get('caseId') ?? '');
  try {
    const supabase = await createSupabaseServerClient();
    const { pending, commRows, today } = await loadMeetingSheet(supabase, caseId);
    const pendingLines = pending
      .slice(0, 20)
      .map(
        (task) =>
          `・${task.title}（期限 ${formatDate(task.due_date.slice(0, 10))}／${TASK_STATUS_LABEL[task.status]}）`,
      );
    const commLines = commRows
      .slice(0, 10)
      .map((row) => `・${formatDate(row.occurred_at.slice(0, 10))} ${row.summary}`);
    const text = [
      `本日: ${formatDate(today)}`,
      pendingLines.length > 0 ? `未完了の宿題:\n${pendingLines.join('\n')}` : '未完了の宿題: なし',
      commLines.length > 0 ? `直近の連絡:\n${commLines.join('\n')}` : '直近の連絡: なし',
    ].join('\n\n');
    const { error } = await supabase.rpc('enqueue_ai_job', {
      p_case_id: caseId,
      p_job_type: 'draft',
      p_input_ref: { text, params: { purpose: 'meeting_sheet_summary' } },
      p_related_task_id: null,
    });
    if (error)
      return { status: 'error', message: '下書きを依頼できませんでした。もう一度お試しください。' };
  } catch {
    return {
      status: 'error',
      message: '情報を読み込めなかったため下書きを依頼していません。画面を開き直してください。',
    };
  }
  revalidatePath(`/cases/${caseId}/sheet`);
  return { status: 'success', message: '下書きを依頼しました。' };
}
