/**
 * POST /api/tasks/{taskId}/submit — 宿題の提出内容・ファイル登録（表6-6）。
 *
 * 正本: 基本設計書 Version 1.2 6-7「業務ロジック：提出物確認と提出の冪等性」および 3-3-3。
 *
 * 複数テーブル（task_submissions／case_tasks／storage_files／communication_logs）へ
 * 書き込むため、Supabase クライアント直アクセスではなく Route Handler に集約する（6-5）。
 *
 * 冪等性（二重送信対策）の要点:
 *   - 同一 case_task_id に review_status が 'draft'／'submitted'（未レビュー）の提出があれば上書き。
 *     未レビュー提出は「訂正前の一時的な状態」なので 409 で弾かずサーバー側で上書きする。
 *   - needs_fix／confirmed からの再提出は新規行とし、is_latest を付け替える。
 *     部分ユニークインデックス task_submissions_latest_uk（UNIQUE(case_task_id) WHERE is_latest）
 *     があるため、必ず「旧行を false → 新行を insert」の順で実行する。
 *   - 上書きで置き換えられた添付ファイルは孤児になるため、旧 file_id の storage_files と
 *     Storage 上の実体を同じ処理内で削除する。
 *   - submission_type は提出時点の case_tasks.submission_format をそのまま複写する。
 *   - case_tasks.status の更新は RPC submit_task() 経由（couple には case_tasks の
 *     update ポリシーが無い。付録A）。一時保存では status を変えない。
 *
 * 【トランザクション境界について】本ハンドラは PostgREST 経由の複数リクエストで構成されるため、
 * 6-7 が求める「同一トランザクション」にはなっていない。ただし各ステップは
 * 「旧行の降格 → 新行の insert → status 更新 → 副次記録」の順で、途中で失敗しても
 * 提出そのものが二重に成立しない並びにしてある。
 * 完全な単一トランザクション化は Phase 2 の課題として 6-7 に残す。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import {
  UNREVIEWED_STATUSES,
  type ReviewStatus,
  type SubmissionFormat,
} from '@/lib/constants';
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

interface LatestSubmissionRow {
  id: string;
  review_status: ReviewStatus;
  file_id: string | null;
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
    const user = await requireRole('couple');

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

    // 添付は「自分がこの案件へ上げたファイル」に限る。他案件の file_id を差し込まれないようにする。
    if (fileId) {
      const fileResult = await supabase
        .from('storage_files')
        .select('id, case_id, uploaded_by, bucket, object_path')
        .eq('id', fileId)
        .maybeSingle();
      if (fileResult.error) throw fromPostgresError(fileResult.error);
      const file = fileResult.data as StorageFileRow | null;
      if (!file || file.case_id !== task.case_id || file.uploaded_by !== user.id) {
        throw badRequest([
          { field: 'fileId', reason: '添付ファイルを確認できませんでした。選び直してください' },
        ]);
      }
    }

    // ------------------------------------------------------------------ 冪等性（6-7）
    const latestResult = await supabase
      .from('task_submissions')
      .select('id, review_status, file_id')
      .eq('case_task_id', taskId)
      .eq('is_latest', true)
      .maybeSingle();
    if (latestResult.error) throw fromPostgresError(latestResult.error);
    const latest = latestResult.data as LatestSubmissionRow | null;

    // 提出済みを draft へ戻すと case_tasks.status='submitted' のまま提出がプランナーから
    // 見えなくなり（付録A task_submissions_hide_draft）、6-8 のリスク算出とも食い違う。
    // couple 側から status を戻す手段は無いので、この遷移は受け付けない。
    if (draft && latest?.review_status === 'submitted') {
      throw unprocessable('提出済みの内容は一時保存に戻せません。修正して提出し直してください');
    }

    const reviewStatus: ReviewStatus = draft ? 'draft' : 'submitted';
    const payload = {
      case_task_id: taskId,
      submitted_by: user.id,
      submission_type: format,
      // text_value は暗号化対象（5-3／13-1）。表示側で復号する。
      text_value: encryptPii(textValue),
      selected_value: selectedValue,
      file_id: fileId,
      comment: body.comment?.trim() || null,
      review_status: reviewStatus,
      submitted_at: new Date().toISOString(),
      is_latest: true,
    };

    let submissionId: string;
    /** 上書きで参照されなくなった旧添付。提出確定後にまとめて消す。 */
    let replacedFileId: string | null = null;

    if (latest && UNREVIEWED_STATUSES.includes(latest.review_status)) {
      // 未レビュー提出は上書き更新する（409 で弾かない）
      const updated = await supabase
        .from('task_submissions')
        .update(payload)
        .eq('id', latest.id)
        .select('id');
      if (updated.error) throw fromPostgresError(updated.error);
      const rows = (updated.data ?? []) as { id: string }[];
      if (rows.length === 0) {
        // 付録A task_submissions_update_couple は submitted_by 本人の行しか更新させない。
        // 相手方（新郎／新婦）の未レビュー提出が最新のときここに来る。
        throw conflict('お相手が入力中の提出があります。画面を開き直してからやり直してください');
      }
      submissionId = rows[0].id;
      if (latest.file_id && latest.file_id !== fileId) replacedFileId = latest.file_id;
    } else {
      if (latest) {
        // needs_fix／confirmed からの再提出。先に旧行の is_latest を落とす（順序が重要）。
        // 部分ユニーク task_submissions_latest_uk があるため、降格より先に insert すると 23505 になる。
        //
        // couple には needs_fix／confirmed の行への update ポリシーが無い（付録A）。
        // 広い update を開く代わりに、この1操作だけを許す security definer 関数を通す。
        const demoted = await supabase.rpc('demote_latest_submission', {
          p_case_task_id: taskId,
        });
        if (demoted.error) throw fromPostgresError(demoted.error);
        if (!demoted.data) {
          // 関数は needs_fix／confirmed の行しか降格しない。ここに来るのは
          // 取得してから降格するまでの間に他の経路で状態が変わった場合。
          throw conflict('提出の状態が変わりました。画面を開き直してからやり直してください');
        }
      }

      const inserted = await supabase.from('task_submissions').insert(payload).select('id').single();
      if (inserted.error) throw fromPostgresError(inserted.error);
      submissionId = (inserted.data as { id: string }).id;
    }

    // 一時保存では case_tasks.status を変えない（4-3 M03／6-7）
    if (!draft) {
      const rpc = await supabase.rpc('submit_task', {
        p_case_task_id: taskId,
        p_status: 'submitted',
      });
      if (rpc.error) throw fromPostgresError(rpc.error);
    }

    if (replacedFileId) await removeOrphanFile(supabase, replacedFileId);
    if (!draft) await logSubmission(supabase, task.case_id, task.title);

    return ok({ id: submissionId, reviewStatus });
  },
);
