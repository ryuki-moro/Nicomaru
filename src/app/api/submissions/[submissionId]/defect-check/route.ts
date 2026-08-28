/**
 * POST /api/submissions/{submissionId}/defect-check — 9-4 ②のジョブ投入（表6-6、Phase 3）。
 *
 * 正本: 基本設計書 7-2／7-3／7-4。
 *
 *   「②ローカルLLMは表記ゆれ候補と敬称の疑いのみを、該当行番号と確信度付きで提示する」
 *   「LLMへの入力は処理に必要な最小限の項目に限定する」
 *
 * 【なぜ /api/ai/jobs ではなくこの専用APIなのか】
 * ②へ渡すのは提出CSVの中身だが、それをクライアントに組み立てさせると
 * 「画面が持っている文字列」がそのまま LLM への入力になる。
 * 7-4 の入力最小化はサーバー側でしか担保できないため、
 * ファイルの取得・列の間引き・長さの打ち切りをここで行い、投入もここから行う。
 *
 * ①ルールベースはこのAPIを経由しない。D02 の描画時に毎回かける（submissionCheck.ts）。
 * LLM が止まっていても①の指摘は必ず出る、という 7-2 の分割をそのまま保つため。
 */
import { ok, route } from '@/lib/api/route';
import { enqueueSubmissionAiJob } from '@/lib/ai/assist';
import { checkSubmittedCsv, csvSchemaOf } from '@/lib/ai/submissionCheck';
import { requireRole } from '@/lib/auth/session';
import { ApiError, fromPostgresError, notFound, unprocessable } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

interface SubmissionRow {
  id: string;
  submission_type: string;
  case_tasks: { id: string; options: Record<string, unknown> | null } | null;
  storage_files: {
    bucket: string;
    object_path: string;
    original_filename: string | null;
    mime_type: string | null;
  } | null;
}

export const POST = route(
  async (_request: Request, context: { params: Promise<{ submissionId: string }> }) => {
    await requireRole('planner', 'admin', 'system_admin');
    const { submissionId } = await context.params;

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('task_submissions')
      .select(
        'id, submission_type,'
        + ' case_tasks!inner ( id, options ),'
        + ' storage_files ( bucket, object_path, original_filename, mime_type )',
      )
      .eq('id', submissionId)
      .maybeSingle();
    // RLS で弾かれた場合も 0 行になる。存在有無を漏らさないよう 404 に寄せる（6-5-1）
    if (error) throw fromPostgresError(error);
    if (!data) throw notFound();

    const submission = data as unknown as SubmissionRow;
    const task = submission.case_tasks;
    if (!task || !submission.storage_files) {
      throw unprocessable('この提出にはチェックできるファイルがありません');
    }

    const schema = csvSchemaOf(task.options);
    if (!schema) {
      // 7-2「提出CSVの期待列は task_templates.default_options のスキーマとして定義する」。
      // 未設定の宿題で列名を推測すると誤検出が出るので、設定が要ることをそのまま伝える。
      throw unprocessable('この宿題にはCSVの期待列が設定されていないためチェックできません');
    }

    const checked = await checkSubmittedCsv(supabase, {
      bucket: submission.storage_files.bucket,
      objectPath: submission.storage_files.object_path,
      fileName: submission.storage_files.original_filename,
      mimeType: submission.storage_files.mime_type,
    }, schema);
    if (!checked) {
      throw unprocessable('提出ファイルをCSVとして読み取れませんでした');
    }
    if (checked.llmInput === '') {
      throw unprocessable('表記ゆれ・敬称を確認できる列がありません');
    }

    const jobId = await enqueueSubmissionAiJob(supabase, task.id, 'defect_check', {
      ref: { table: 'task_submissions', id: submission.id },
      text: checked.llmInput,
    });
    if (!jobId) {
      throw new ApiError('INTERNAL_ERROR', 'AIへの依頼を登録できませんでした');
    }

    return ok({ jobId, rowCount: checked.rowCount }, 202);
  },
);
