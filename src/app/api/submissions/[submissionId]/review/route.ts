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
import { ok, parseBody, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { notFound } from '@/lib/errors';
import { isUuid } from '@/lib/uuid';
import { reviewSubmissionSchema } from '@/lib/validation';
/** review_submission() の戻り。 */
interface ReviewResult {
  submission_id: string;
  case_id: string;
  case_task_id: string;
  task_title: string;
}
export const POST = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        submissionId: string;
      }>;
    },
  ) => {
    const { submissionId } = await context.params;
    const user = await requireStaff();
    if (!isUuid(submissionId)) throw notFound();
    const input = await parseBody(request, reviewSubmissionSchema);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { reviewSubmission } = await import('@/lib/d1/tasks');
      return ok(await reviewSubmission(await localDB(), user, submissionId, input));
    }
  },
);
