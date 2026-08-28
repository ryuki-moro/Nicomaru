/**
 * POST /api/tasks/{taskId}/submit — 宿題の提出内容・ファイル登録（表6-6）。
 *
 * 正本: 基本設計書 Version 1.2 6-7「業務ロジック：提出物確認と提出の冪等性」および 3-3-3。
 *
 * 複数テーブル（task_submissions／case_tasks／storage_files／communication_logs）へ
 * 書き込むため、Supabase クライアント直アクセスではなく Route Handler に集約する（6-5）。
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
import type { SupabaseClient } from '@supabase/supabase-js';

import { ok, parseBody, route } from '@/lib/api/route';
import { enqueueSubmissionAiJob, trimForAi } from '@/lib/ai/assist';
import { requireRole } from '@/lib/auth/session';
import { type SubmissionFormat } from '@/lib/constants';
import { encryptPii } from '@/lib/crypto';
import {
  badRequest,
  conflict,
  fromPostgresError,
  notFound,
  unprocessable,
  type ErrorDetail,
} from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { submitTaskSchema } from '@/lib/validation';

// node:crypto と暗号化（13-1）を使うため Edge ではなく Node ランタイムで動かす
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * 上書きで置き換えられた添付ファイルを消す（6-7）。
 *
 * storage_files の delete ポリシーと Storage 側の case_files_delete は
 * 20260828000900_submission_functions.sql で定義済み。
 * それでも失敗した場合（実体が既に無い等）は提出自体が成功しているため
 * 500 にはせず、警告を残して継続する。
 */
async function removeOrphanFile(supabase: SupabaseClient, fileId: string): Promise<void> {
  const { data, error } = await supabase
    .from('storage_files')
    .select('id, case_id, uploaded_by, bucket, object_path')
    .eq('id', fileId)
    .maybeSingle();
  if (error || !data) {
    console.warn('[submit] 置き換え前ファイルのメタ情報を取得できませんでした', fileId, error);
    return;
  }
  const file = data as StorageFileRow;

  // 実体 → メタの順に消す。逆順だと実体だけが残り、案件単位の自動削除（6-11）からも漏れる。
  const removed = await supabase.storage.from(file.bucket).remove([file.object_path]);
  if (removed.error) {
    console.warn('[submit] Storage 上の実体を削除できませんでした', file.object_path, removed.error);
    return;
  }
  const deleted = await supabase.from('storage_files').delete().eq('id', file.id).select('id');
  if (deleted.error || (deleted.data ?? []).length === 0) {
    console.warn(
      '[submit] storage_files を削除できませんでした（付録A に delete ポリシーが必要）',
      file.id,
      deleted.error,
    );
  }
}

/**
 * 提出を communication_logs に自動記録する（6-7 の「3・4・5 の各時点で自動記録」）。
 *
 * communication_logs は直接 insert させず log_communication() 経由にする。
 * created_by を引数で受け取らず関数内で auth.uid() から解決するため、実行者を偽装できない
 * （log_audit() と同じ考え方。20260828000900_submission_functions.sql）。
 * 連絡履歴は提出の副次記録なので、これを理由に提出自体を失敗させない。
 */
async function logSubmission(
  supabase: SupabaseClient,
  caseId: string,
  title: string,
): Promise<void> {
  const { error } = await supabase.rpc('log_communication', {
    p_case_id: caseId,
    p_channel: 'in_app',
    p_direction: 'inbound',
    p_source: 'submit',
    p_summary: `「${title}」が提出されました`,
  });
  if (error) {
    console.warn('[submit] communication_logs に記録できませんでした', error);
  }
}

export const POST = route(
  async (request: Request, context: { params: Promise<{ taskId: string }> }) => {
    // 表6-6: 認証必須（couple、自身の案件のみ）。案件の範囲は RLS が担保する。
    await requireRole('couple');

    const { taskId } = await context.params;
    if (!UUID_RE.test(taskId)) throw notFound();

    const body = await parseBody(request, submitTaskSchema);
    const supabase = await createSupabaseServerClient();

    const taskResult = await supabase
      .from('case_tasks')
      .select('id, case_id, title, submission_format, options, status')
      .eq('id', taskId)
      .maybeSingle();
    if (taskResult.error) throw fromPostgresError(taskResult.error);
    if (!taskResult.data) throw notFound();
    const task = taskResult.data as CaseTaskRow;

    // waived（マイページ表示は「対応不要」）は提出の対象外（表6-9）
    if (task.status === 'waived') {
      throw unprocessable('この宿題は対応不要になっているため提出できません');
    }

    // 提出形式の正本は case_tasks 側（6-7）。画面が保持している値とズレていたら開き直してもらう。
    const format = task.submission_format;
    if (body.submissionType !== format) {
      throw conflict('宿題の内容が更新されています。画面を開き直してからやり直してください');
    }

    // 「確認しました」の1行を作るだけの宿題に一時保存の概念は無い（4-3 表4-13）
    if (format === 'none' && body.draft) {
      throw badRequest([{ field: 'draft', reason: '確認のみの宿題は一時保存できません' }]);
    }
    const draft = body.draft;

    // ---------------------------------------------------------- 内容の業務チェック
    const details: ErrorDetail[] = [];
    let textValue: string | null = null;
    let selectedValue: string | null = null;
    let fileId: string | null = null;

    switch (format) {
      case 'text':
        // 文字数上限2000字は submitTaskSchema（表4-13）で検証済み
        textValue = body.textValue?.trim() || null;
        if (!draft && !textValue) {
          details.push({ field: 'textValue', reason: '回答を入力してください' });
        }
        break;
      case 'select': {
        selectedValue = body.selectedValue?.trim() || null;
        const choices = choicesOf(task.options);
        if (!draft && !selectedValue) {
          details.push({ field: 'selectedValue', reason: '選択してください' });
        } else if (selectedValue && !choices.includes(selectedValue)) {
          details.push({ field: 'selectedValue', reason: '選択肢の中から選んでください' });
        }
        break;
      }
      case 'file':
        fileId = body.fileId ?? null;
        if (!draft && !fileId) {
          details.push({ field: 'fileId', reason: 'ファイルを選んでください' });
        }
        break;
      case 'none':
        // 本文列はすべて NULL のまま1行作る（6-7）
        break;
    }
    if (details.length > 0) throw badRequest(details);

    // 添付は「この案件のファイル」に限る。他案件の file_id を差し込まれないようにする。
    //
    // 提出は案件を共有する新郎新婦で1つ（6-7）なので、相手が添付したファイルを引き継いだ
    // 再提出も通常フローになる（M03 は「選び直さなければこのまま提出されます」と案内している）。
    // uploaded_by = 実行者まで求めると、その案内どおりに操作しただけで必ず 400 になる。
    // 「他人のファイルを勝手に登録できない」担保は storage_files_insert（uploaded_by は
    // current_app_user 固定）と storage_files_hide_planner_only が既に行っており、
    // ここで重ねる必要は無い（付録A）。
    if (fileId) {
      const fileResult = await supabase
        .from('storage_files')
        .select('id, case_id')
        .eq('id', fileId)
        .maybeSingle();
      if (fileResult.error) throw fromPostgresError(fileResult.error);
      const file = fileResult.data as Pick<StorageFileRow, 'id' | 'case_id'> | null;
      if (!file || file.case_id !== task.case_id) {
        throw badRequest([
          { field: 'fileId', reason: '添付ファイルを確認できませんでした。選び直してください' },
        ]);
      }
    }

    // ------------------------------------------------------------------ 冪等性（6-7）
    // 最新提出の判定・上書き／降格・新規行・case_tasks の更新をひとまとめにする。
    // 個々の理由は submit_task_atomic() 側のコメントに書いてある。
    const { data: result, error: rpcError } = await supabase.rpc('submit_task_atomic', {
      p_case_task_id: taskId,
      p_submission_type: format,
      // text_value は暗号化対象（5-3／13-1）。表示側で復号する。
      p_text_value: encryptPii(textValue),
      p_selected_value: selectedValue,
      p_file_id: fileId,
      p_comment: body.comment?.trim() || null,
      p_draft: draft,
    });
    if (rpcError) throw fromPostgresError(rpcError);

    // 0 行 = RLS の範囲外。存在有無を漏らさないため 404 に寄せる（6-5-1）
    const rows = (result ?? []) as { submission_id: string; replaced_file_id: string | null }[];
    if (rows.length === 0) throw notFound();
    const submissionId = rows[0].submission_id;
    /** 上書きで参照されなくなった旧添付。Storage は戻せないので確定後に消す。 */
    const replacedFileId = rows[0].replaced_file_id;

    if (replacedFileId) await removeOrphanFile(supabase, replacedFileId);
    if (!draft) await logSubmission(supabase, task.case_id, task.title);

    // 自由記述の分類（機能9-1）。7-3「提出…を契機とするジョブは
    // couple／planner の操作APIのサーバー側処理から内部呼び出しで投入し、
    // クライアントから /api/ai/jobs を直接呼ばせない」。
    //
    // 一時保存では投入しない。書きかけを分類しても意味が無く、
    // 提出まで往復するたびにジョブが積み上がる。
    //
    // 提出物の不備一次チェック（機能9-4）はここでは投入しない。
    // ①ルールベースは D02 の描画時に毎回かけ（LLM の状態に依存させない）、
    // ②LLM は CSV の該当列だけを抜いて渡す必要があるため、
    // プランナー操作の /api/submissions/{id}/defect-check から投入する（7-4 の入力最小化）。
    if (!draft && format === 'text') {
      const forAi = trimForAi(textValue);
      if (forAi) {
        await enqueueSubmissionAiJob(supabase, taskId, 'classification', {
          ref: { table: 'task_submissions', id: submissionId },
          text: forAi,
        });
      }
    }

    return ok({ id: submissionId, reviewStatus: draft ? 'draft' : 'submitted' });
  },
);
