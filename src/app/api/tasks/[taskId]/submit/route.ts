/**
 * POST /api/tasks/{taskId}/submit — 宿題の提出内容・ファイル登録（表6-6）。
 *
 * 正本: 基本設計書 Version 1.2 6-7「業務ロジック：提出物確認と提出の冪等性」および 3-3-3。
 *
 * 複数テーブル（task_submissions／case_tasks／storage_files／communication_logs）へ
 *
 * 提出の単位は「利用者」ではなく「案件」。新郎新婦は1つの案件・同じ case_tasks を共有し（2-3、6-6-1）、
 * 宿題1件に対する最新提出も部分ユニークで1行に限られるため、どちらが操作しても同じ提出を指す。
 * 相手の未レビュー提出（draft を含む）も上書きの対象になる（6-7）。
 *
 * 冪等性（二重送信対策）の要点:
 *   - 同一 case_task_id に review_status が 'draft'／'submitted'（未レビュー）の提出があれば上書き。
 *     未レビュー提出は「訂正前の一時的な状態」なので 409 で弾かずサーバー側で上書きする。
 *     提出者が誰かは条件にしない（6-7）。上書き時は submitted_by を実行者へ付け替える。
 *   - needs_fix／confirmed からの再提出は新規行とし、is_latest を付け替える。
 *     部分ユニークインデックス task_submissions_latest_uk（UNIQUE(case_task_id) WHERE is_latest）
 *     があるため、必ず「旧行を false → 新行を insert」の順で実行する。
 *   - 上書きで置き換えられた添付ファイルは孤児になるため、旧 file_id の storage_files と
 *     Storage 上の実体を同じ処理内で削除する。
 *   - submission_type は提出時点の case_tasks.submission_format をそのまま複写する。
 *   - 一時保存では case_tasks.status を変えない。
 *     confirmed からの再提出では confirmed_by／confirmed_at も消す
 *     （未確認の状態に戻った宿題に前回の確認者を残さない。3-3-4）。
 *
 * 【トランザクション境界】6-7 が求める単一トランザクションは
 * submit_task_atomic()（20260828002100_submission_transactions.sql）が担う。
 * 上の一連のDB更新は関数1本の中で行われ、途中で失敗すれば全部戻る。
 * 関数は security definer にしていないので、中の各文にはこれまでと同じ RLS が効く。
 *
 * このハンドラに残るのは、トランザクションに入れられない・入れるべきでないものだけ。
 *   - 入力の業務チェック（提出形式との整合、添付が同じ案件のものか）
 *   - Storage 上の実体の削除。外部ストレージなのでロールバックできない。
 *     提出が確定してから消す
 *   - 連絡履歴の記録とAIジョブの投入。どちらも副次的な記録で、
 *     失敗を理由に提出そのものを取り消すべきではない（7-1）
 */
import { trimForAi } from '@/lib/ai/assist';
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { type SubmissionFormat } from '@/lib/constants';
import { submitTaskSchema } from '@/lib/validation';
// node:crypto と暗号化（13-1）を使うため Edge ではなく Node ランタイムで動かす
export const runtime = 'nodejs';
interface CaseTaskRow {
  id: string;
  case_id: string;
  title: string;
  submission_format: SubmissionFormat;
  options: Record<string, unknown> | null;
  status: string;
}
interface StorageFileRow {
  id: string;
  case_id: string;
  uploaded_by: string;
  bucket: string;
  object_path: string;
}
/** case_tasks.options（jsonb）から選択肢を取り出す。想定外の形は「選択肢なし」として扱う。 */
function choicesOf(options: Record<string, unknown> | null): string[] {
  const raw = options?.choices;
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}
export const POST = route(
  async (
    request: Request,
    context: {
      params: Promise<{
        taskId: string;
      }>;
    },
  ) => {
    // 表6-6: 認証必須（couple、自身の案件のみ）。案件の範囲は RLS が担保する。
    const user = await requireRole('couple');
    const { taskId } = await context.params;
    const body = await parseBody(request, submitTaskSchema);
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { submitTask } = await import('@/lib/d1/tasks');
      const db = await localDB();
      const result = await submitTask(db, user, taskId, body);
      // 分類（9-1）の投入。失敗しても提出は取り消さない（7-1）。
      const forAi = !body.draft && body.submissionType === 'text' && trimForAi(body.textValue);
      if (forAi) {
        const { enqueueTaskJob } = await import('@/lib/d1/ai');
        await enqueueTaskJob(db, user, taskId, 'classification', {
          ref: { table: 'task_submissions', id: result.id },
          text: forAi,
          params: {},
        }).catch((error: unknown) => console.warn('[ai] ジョブを投入できませんでした', error));
      }
      return ok(result);
    }
  },
);
