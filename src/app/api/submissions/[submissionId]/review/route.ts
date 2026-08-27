/**
 * POST /api/submissions/{submissionId}/review — 確認済・不備ありの登録（6-5 表6-6、3-3-4）。
 *
 * task_submissions と case_tasks を跨いで更新するため、
 * 「複数テーブル更新はサーバー側APIに集約する」という 6-5 の原則に従い Route Handler にする。
 * 権限は requireStaff() で入口を絞り、実際の範囲制御は RLS に委譲する（6-5）。
 *
 * Phase の切り分け:
 *   - needs_fix 時の通知（7-1／7-2）は Phase 2。ここでは notifications を作らない。
 *   - 代わりに 6-7 の「3・4・5 の各時点で communication_logs に自動記録」に従い
 *     source='review' の連絡履歴だけを残す。
 */
import { requireStaff } from '@/lib/auth/session';
import { ok, parseBody, route } from '@/lib/api/route';
import { REVIEW_STATUS_LABEL, type ReviewStatus, type TaskStatus } from '@/lib/constants';
import { conflict, fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { reviewSubmissionSchema } from '@/lib/validation';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SubmissionRow {
  id: string;
  case_task_id: string;
  review_status: ReviewStatus;
  case_tasks: { id: string; title: string; case_id: string; status: TaskStatus };
}

export const POST = route(
  async (request: Request, context: { params: Promise<{ submissionId: string }> }) => {
    const { submissionId } = await context.params;
    const user = await requireStaff();
    if (!UUID_PATTERN.test(submissionId)) throw notFound();

    const input = await parseBody(request, reviewSubmissionSchema);
    const supabase = await createSupabaseServerClient();

    // 状態と案件IDを先に取る。RLS 外の提出は 0 行になるので存在有無を漏らさず 404 になる
    const { data, error } = await supabase
      .from('task_submissions')
      .select('id, case_task_id, review_status, case_tasks!inner ( id, title, case_id, status )')
      .eq('id', submissionId)
      .maybeSingle();
    if (error) throw fromPostgresError(error);
    if (!data) throw notFound();

    const submission = data as unknown as SubmissionRow;
    // 一時保存（draft）は確認対象ではなく、確認済みの提出への再確認も認めない（6-7）
    if (submission.review_status !== 'submitted') throw conflict();

    // 提出後にプランナーが宿題を「対応不要」にした場合、提出は submitted のまま残る。
    // ここで確認すると下の case_tasks 更新が status を confirmed／needs_fix で上書きし、
    // 免除（表6-9 waived）が黙って外れて 6-8 の未提出判定に戻ってしまう。
    // 免除の解除は K02 の「対応不要を解除」で明示的に行う操作なので、確認側では受け付けない。
    if (submission.case_tasks.status === 'waived') {
      throw unprocessable('この宿題は「対応不要」になっているため、確認の必要はありません');
    }

    const reviewedAt = new Date().toISOString();

    // review_status='submitted' を条件に含めることで、同時確認を 0 行更新＝409 として検出する
    const { data: updated, error: updateError } = await supabase
      .from('task_submissions')
      .update({
        review_status: input.decision,
        planner_feedback: input.comment ?? null,
        reviewed_by: user.id,
        reviewed_at: reviewedAt,
      })
      .eq('id', submissionId)
      .eq('review_status', 'submitted')
      .select('id')
      .maybeSingle();
    if (updateError) throw fromPostgresError(updateError);
    if (!updated) throw conflict();

    // 【Phase 1 の割り切り】PostgREST 経由の2回の UPDATE は同一トランザクションにならない。
    // 先に提出側を確定させることで、2人のプランナーが同時に確認しても
    // 勝った1人だけが case_tasks を書き換える（負けた側は上の 0 行更新で 409 になる）。
    // 逆に case_tasks の更新が落ちた場合は提出だけが確定して残るが、
    // RLS（task_submissions_review_planner の WITH CHECK）が 'submitted' への差し戻しを
    // 禁じているため補償更新は書けない。単一トランザクション化は 6-7 の security definer 関数
    // （submit_task と同じ形）を追加する Phase 2 の課題として残す。

    // case_tasks.status は提出の確認状態と同じ値に揃える（3-3-4）。
    // needs_fix では confirmed_by／confirmed_at を消す。列の意味は「確認した」であり、
    // 再提出で不備ありに戻った案件に前回の確認者が残ると D03・監査で誤読されるため。
    const { error: taskError } = await supabase
      .from('case_tasks')
      .update({
        status: input.decision,
        confirmed_by: input.decision === 'confirmed' ? user.id : null,
        confirmed_at: input.decision === 'confirmed' ? reviewedAt : null,
        updated_at: reviewedAt,
      })
      .eq('id', submission.case_task_id);
    if (taskError) throw fromPostgresError(taskError);

    await recordCommunicationLog({
      supabase,
      caseId: submission.case_tasks.case_id,
      summary:
        `宿題「${submission.case_tasks.title}」を${REVIEW_STATUS_LABEL[input.decision]}にしました`
        + (input.decision === 'needs_fix' && input.comment ? `：${input.comment}` : ''),
    });

    return ok({
      id: submission.id,
      caseId: submission.case_tasks.case_id,
      caseTaskId: submission.case_task_id,
      reviewStatus: input.decision,
    });
  },
);

/**
 * 6-7 の自動記録。
 *
 * communication_logs は直接 insert させず log_communication() 経由にする。
 * created_by を引数で受け取らず関数内で auth.uid() から解決するため実行者を偽装できない
 * （log_audit() と同じ考え方。20260828000900_submission_functions.sql）。
 * 連絡履歴は D03（Phase 2）の参考情報であって確認結果そのものではないため、
 * ここで失敗しても確定済みのレビューを巻き戻さず、サーバーログにだけ残す。
 */
async function recordCommunicationLog({
  supabase,
  caseId,
  summary,
}: {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  caseId: string;
  summary: string;
}): Promise<void> {
  const { error } = await supabase.rpc('log_communication', {
    p_case_id: caseId,
    // Phase 1 の通知先はマイページ内のみ（LINE／メール送信は Phase 2 の 7-1／7-2）
    p_channel: 'in_app',
    p_direction: 'outbound',
    p_source: 'review',
    p_summary: summary,
  });
  if (error) {
    console.warn('[review] communication_logs への記録に失敗しました', error);
  }
}
