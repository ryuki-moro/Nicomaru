/**
 * POST /api/submissions/{submissionId}/review — 確認済・不備ありの登録（6-5 表6-6、3-3-4）。
 *
 * task_submissions と case_tasks を跨いで更新するため、
 * 「複数テーブル更新はサーバー側APIに集約する」という 6-5 の原則に従い Route Handler にする。
 * 権限は requireStaff() で入口を絞り、実際の範囲制御は RLS に委譲する（6-5）。
 *
 * 【トランザクション境界】2つの更新は review_submission()
 * （20260828002100_submission_transactions.sql）の中で1トランザクションになる。
 *
 * 分けていたときは補償できない穴があった。
 * task_submissions を confirmed にしたあと case_tasks の更新が落ちると、
 * 提出だけが確認済みで宿題は submitted のまま残る。
 * RLS（task_submissions_review_planner の WITH CHECK）が submitted への差し戻しを
 * 禁じているため、アプリ側から巻き戻せない。
 *
 * 通知（7-1／7-2）は notifications 側の仕組みに任せ、ここでは作らない。
 * 6-7 の「3・4・5 の各時点で communication_logs に自動記録」に従い、
 * source='review' の連絡履歴だけをトランザクションの外で残す。
 * 連絡履歴は参考情報であって確認結果そのものではないため、
 * その失敗で確定済みのレビューを巻き戻さない。
 */
import { requireStaff } from '@/lib/auth/session';
import { ok, parseBody, route } from '@/lib/api/route';
import { REVIEW_STATUS_LABEL } from '@/lib/constants';
import { fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { reviewSubmissionSchema } from '@/lib/validation';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** review_submission() の戻り。 */
interface ReviewResult {
  submission_id: string;
  case_id: string;
  case_task_id: string;
  task_title: string;
}

export const POST = route(
  async (request: Request, context: { params: Promise<{ submissionId: string }> }) => {
    const { submissionId } = await context.params;
    await requireStaff();
    if (!UUID_PATTERN.test(submissionId)) throw notFound();

    const input = await parseBody(request, reviewSubmissionSchema);
    const supabase = await createSupabaseServerClient();

    // 状態チェック（draft・確認済み・対応不要）も関数の中で行う。
    // チェックと更新を別トランザクションにすると、その間に状態が変わりうる。
    const { data, error } = await supabase.rpc('review_submission', {
      p_submission_id: submissionId,
      p_decision: input.decision,
      p_comment: input.comment ?? null,
    });
    if (error) throw fromPostgresError(error);

    // 0 行 = RLS の範囲外。存在有無を漏らさないため 404 に寄せる（6-5-1）
    const rows = (data ?? []) as ReviewResult[];
    if (rows.length === 0) throw notFound();
    const result = rows[0];

    await recordCommunicationLog({
      supabase,
      caseId: result.case_id,
      summary:
        `宿題「${result.task_title}」を${REVIEW_STATUS_LABEL[input.decision]}にしました`
        + (input.decision === 'needs_fix' && input.comment ? `：${input.comment}` : ''),
    });

    return ok({
      id: result.submission_id,
      caseId: result.case_id,
      caseTaskId: result.case_task_id,
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
