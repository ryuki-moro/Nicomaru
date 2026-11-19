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
import { csvSchemaOf } from '@/lib/ai/submissionCheck';
import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { checkStoredCsv, enqueueTaskJob } from '@/lib/d1/ai';
import { localDB, localFiles } from '@/lib/d1/runtime';
import { submissionRow } from '@/lib/d1/tasks';
import { unprocessable } from '@/lib/errors';
export const runtime = 'nodejs';
interface SubmissionRow {
  id: string;
  submission_type: string;
  case_tasks: {
    id: string;
    options: Record<string, unknown> | null;
  } | null;
  storage_files: {
    bucket: string;
    object_path: string;
    original_filename: string | null;
    mime_type: string | null;
  } | null;
}
export const POST = route(
  async (
    _request: Request,
    context: {
      params: Promise<{
        submissionId: string;
      }>;
    },
  ) => {
    const user = await requireRole('planner', 'admin', 'system_admin');
    const { submissionId } = await context.params;
    {
      const db = await localDB();
      const row = await submissionRow(db, user, submissionId);
      if (!row.storage_files) throw unprocessable('この提出にはチェックできるファイルがありません');
      if (!csvSchemaOf(row.case_tasks.options))
        throw unprocessable('この宿題にはCSVの期待列が設定されていないためチェックできません');
      const checked = await checkStoredCsv(
        await localFiles(),
        row.storage_files,
        row.case_tasks.options,
      );
      if (!checked) throw unprocessable('提出ファイルをCSVとして読み取れませんでした');
      if (checked.llmInput === '') throw unprocessable('表記ゆれ・敬称を確認できる列がありません');
      const jobId = await enqueueTaskJob(db, user, row.case_tasks.id, 'defect_check', {
        ref: { table: 'task_submissions', id: row.id },
        text: checked.llmInput,
        params: {},
      });
      return ok({ jobId, rowCount: checked.rowCount }, 202);
    }
  },
);
