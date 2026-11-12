/**
 * M03 宿題詳細・提出（couple）。
 *
 * 正本: 基本設計書 Version 1.2 3-3-3「宿題詳細・提出」および 4-3「M03」表4-13。
 *   - 説明・提出フォーマット・選択肢・期限を表示する。値はすべて case_tasks に
 *     スナップショットされているため、task_templates は参照しない（6-6-2）。
 *   - 表示する入力項目は case_tasks.submission_format に従う（text／select／file／none）。
 *
 * /api/tasks/{taskId}/submit に寄せる。どの宿題が見えるかは付録A の RLS が決める。
 */
import { ConfirmedAnswer } from '@/app/(couple)/mypage/tasks/[taskId]/ConfirmedAnswer';
import { SubmitForm } from '@/app/(couple)/mypage/tasks/[taskId]/SubmitForm';
import { taskBackHref } from '@/app/(couple)/mypage/tasks/taskLinks';
import { TaskStatusBadge } from '@/components/ui/StatusBadge';
import { requireRole } from '@/lib/auth/session';
import {
  ALLOWED_FILE_TYPES,
  type AllowedFileType,
  type ReviewStatus,
  type SubmissionFormat,
  type TaskStatus,
} from '@/lib/constants';
import { isEncrypted, readPii } from '@/lib/crypto';
import { localDB } from '@/lib/d1/runtime';
import { latestSubmission, taskRow } from '@/lib/d1/tasks';
import { formatDateJp } from '@/lib/format';
import { type IsoDate } from '@/lib/services/schedule';
import { TASK_ANSWER_METHOD_LABEL } from '@/lib/task-display';
import Link from 'next/link';
import { notFound } from 'next/navigation';
export const metadata = { title: '宿題の詳細' };
interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  submission_format: SubmissionFormat;
  allowed_file_types: unknown;
  options: Record<string, unknown> | null;
  due_date: IsoDate;
  status: TaskStatus;
}
interface SubmissionRow {
  id: string;
  text_value: string | null;
  selected_value: string | null;
  file_id: string | null;
  comment: string | null;
  review_status: ReviewStatus;
  planner_feedback: string | null;
}
/**
 * task_submissions.text_value はアプリ側 AES-256-GCM の暗号化対象（5-3／13-1）。
 * 開発用シードなど平文のまま入っている値も表示できるよう readPii を使う。
 *
 * ただしここは「提出フォームの初期値」なので、読めなかった値をそのまま入れると
 * 暗号文が本文として提出され直す。readPii は復号できない値を素通しするため、
 * 暗号化形式のまま残っているものだけ空欄にする。
 */
function initialText(stored: string | null): string {
  const value = readPii(stored);
  return isEncrypted(value) ? '' : value;
}
function choicesOf(options: Record<string, unknown> | null): string[] {
  const raw = options?.choices;
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}
function allowedTypesOf(raw: unknown): AllowedFileType[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is AllowedFileType =>
      typeof v === 'string' && (ALLOWED_FILE_TYPES as readonly string[]).includes(v),
  );
}
export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{
    taskId: string;
  }>;
  searchParams: Promise<{
    from?: string | string[];
  }>;
}) {
  const { taskId } = await params;
  const backHref = taskBackHref((await searchParams).from);
  const user = await requireRole('couple');
  const taskResult = {
    data: await taskRow(await localDB(), user, taskId).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'status' in error && error.status === 404)
        notFound();
      throw error;
    }),
    error: null,
  };
  // 不存在・権限外はいずれも 404 として扱う（4-3 エラー表示規約）。
  // RLS で弾かれた場合も 0 行として返るため、存在の有無を推測させない。
  if (taskResult.error || !taskResult.data) notFound();
  const task = taskResult.data as TaskRow;
  // 最新提出。draft は本人にしか見えない（付録A task_submissions_hide_draft）。
  const submissionResult = { data: await latestSubmission(await localDB(), user, taskId) };
  const latest = (submissionResult.data ?? null) as SubmissionRow | null;
  let attachedFileName: string | null = null;
  if (latest?.file_id) {
    const fileResult = {
      data: await (
        await localDB()
      )
        .prepare('SELECT original_filename FROM storage_files WHERE id=? AND case_id=?')
        .bind(
          latest.file_id,
          (
            taskResult.data as {
              case_id?: string;
            }
          ).case_id ?? '',
        )
        .first(),
    };
    attachedFileName =
      (
        fileResult.data as {
          original_filename: string | null;
        } | null
      )?.original_filename ?? null;
  }
  const format = task.submission_format;
  const defaultText = initialText(latest?.text_value ?? null);
  const defaultComment = latest?.comment ?? '';
  // 確認済の宿題で読み取り表示する回答。空の項目は出さない。
  const answerItems = [
    { label: '回答', value: format === 'text' ? defaultText : (latest?.selected_value ?? '') },
    { label: '添付ファイル', value: attachedFileName ?? '' },
    { label: '補足', value: defaultComment },
  ].filter((item) => item.value !== '');
  const form = (
    <SubmitForm
      taskId={task.id}
      submissionFormat={format}
      choices={choicesOf(task.options)}
      allowedFileTypes={allowedTypesOf(task.allowed_file_types)}
      defaultText={defaultText}
      defaultSelected={latest?.selected_value ?? ''}
      defaultComment={defaultComment}
      defaultFileId={latest?.file_id ?? null}
      defaultFileName={attachedFileName}
      // submission_format='none' はボタンのラベルだけを差し替える（表4-13）
      submitLabel={format === 'none' ? '確認しました' : '提出する'}
      canSaveDraft={latest?.review_status !== 'submitted'}
      backHref={backHref}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="text-title font-bold text-text-primary">{task.title}</h1>
        <div className="mt-2 flex items-center gap-2">
          <TaskStatusBadge status={task.status} />
          <span className="text-label text-text-muted">
            {formatDateJp(task.due_date)}まで・{TASK_ANSWER_METHOD_LABEL[format]}
          </span>
        </div>
      </header>

      {task.description && (
        <p className="card whitespace-pre-wrap text-body text-text-secondary">{task.description}</p>
      )}

      {/* 不備あり時のプランナーコメント。責める調子にならないよう情報バナーで示す（4-3 M01 の方針） */}
      {task.status === 'needs_fix' && latest?.planner_feedback && (
        <div className="banner-info">
          <span>
            <span className="block font-bold">プランナーからのご連絡</span>
            <span className="block whitespace-pre-wrap">{latest.planner_feedback}</span>
          </span>
        </div>
      )}

      {latest?.review_status === 'draft' && (
        <div className="banner-info">
          <span>保存した内容を読み込みました。続きから入力できます。</span>
        </div>
      )}

      {task.status === 'confirmed' && (
        <div className="banner-info">
          <span>
            {format === 'none'
              ? '確認済みです。'
              : '確認済みです。内容を変えたいときは「内容を変更する」を押してください。'}
          </span>
        </div>
      )}

      {task.status === 'waived' ? (
        // waived（マイページ表示は「対応不要」）は提出の対象外（表6-9）
        <>
          <p className="card text-label text-text-secondary">
            この宿題は対応不要になりました。提出は必要ありません。
          </p>
          <Link href={backHref} className="btn-ghost self-center">
            戻る
          </Link>
        </>
      ) : task.status === 'confirmed' ? (
        <ConfirmedAnswer items={answerItems} backHref={backHref} canChange={format !== 'none'}>
          {form}
        </ConfirmedAnswer>
      ) : (
        form
      )}
    </div>
  );
}
