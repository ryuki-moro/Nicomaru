/**
 * D02 提出物確認画面 — 提出内容の表示と確認（3-3-4 機能4-3、4-3 D02、6-7）。
 *
 * 表示は Server Component から RLS 適用クライアントで直接 select し（6-5）、
 * ステータス確定だけを Route Handler（/api/submissions/{id}/review）に投げる。
 * 複数テーブル（task_submissions／case_tasks／communication_logs）を跨ぐ更新のため、
 * ここは 6-5 の「サーバー側APIに集約する」条件に当たる。
 *
 * AI補助（Phase 3）はこの画面に3つ乗る（7-2）。
 *   9-1 分類        … 提出時に自動投入されたジョブの結果を表示・修正（ClassificationPanel）
 *   9-3 文面下書き  … 確認フォームの中（ReviewForm → DraftAssist）
 *   9-4 不備チェック … ①ルールベースはここで毎回かけ、②LLM は画面から依頼（DefectPanel）
 * いずれも失敗しても確認作業は続けられる（7-1「他機能の利用に影響を与えない」）。
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ClassificationPanel } from '@/app/(staff)/submissions/[submissionId]/ClassificationPanel';
import { DefectPanel } from '@/app/(staff)/submissions/[submissionId]/DefectPanel';
import { ReviewForm, SubmissionFileLink } from '@/app/(staff)/submissions/[submissionId]/ReviewForm';
import { ReviewStatusBadge, TaskStatusBadge } from '@/components/ui/StatusBadge';
import { fetchAiAssistStatus, latestJobForTask } from '@/lib/ai/assist';
import type { DefectFinding } from '@/lib/ai/defectCheck';
import { checkSubmittedCsv, csvSchemaOf } from '@/lib/ai/submissionCheck';
import {
  COUPLE_PROFILE_COLUMNS,
  SUBMISSION_FORMAT_LABEL,
  type ReviewStatus,
  type SubmissionFormat,
  type TaskStatus,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { fromPostgresError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface SubmissionDetail {
  id: string;
  submission_type: SubmissionFormat;
  text_value: string | null;
  selected_value: string | null;
  content_json: unknown;
  file_id: string | null;
  comment: string | null;
  review_status: ReviewStatus;
  planner_feedback: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  case_tasks: {
    id: string;
    title: string;
    description: string | null;
    due_date: string;
    status: TaskStatus;
    case_id: string;
    /** 9-4 ①の期待列（task_templates.default_options から複写される。7-2） */
    options: Record<string, unknown> | null;
    wedding_cases: { id: string; case_code: string; wedding_date: string };
  };
  storage_files: {
    id: string;
    bucket: string;
    object_path: string;
    original_filename: string | null;
    mime_type: string | null;
    file_size_bytes: number | null;
  } | null;
}

interface CoupleProfileRow {
  partner_role: string;
  full_name: string | null;
  is_primary_contact: boolean;
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '';
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

export default async function SubmissionReviewPage({
  params,
}: {
  params: Promise<{ submissionId: string }>;
}) {
  const { submissionId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('task_submissions')
    .select(
      'id, submission_type, text_value, selected_value, content_json, file_id, comment,'
      + ' review_status, planner_feedback, submitted_at, reviewed_at,'
      + ' case_tasks!inner ( id, title, description, due_date, status, case_id, options,'
      + ' wedding_cases!inner ( id, case_code, wedding_date ) ),'
      + ' storage_files ( id, bucket, object_path, original_filename, mime_type, file_size_bytes )',
    )
    .eq('id', submissionId)
    .maybeSingle();
  // RLS で弾かれた場合も 0 行になるため、404 として扱う（存在有無を漏らさない。4-3／6-5-1）
  if (error) throw fromPostgresError(error);
  if (!data) notFound();

  const submission = data as unknown as SubmissionDetail;
  const task = submission.case_tasks;
  const weddingCase = task.wedding_cases;

  // couple_profiles は memo が列レベルで剥奪されているため COUPLE_PROFILE_COLUMNS を使う（付録A）
  const { data: profiles, error: profileError } = await supabase
    .from('couple_profiles')
    .select(COUPLE_PROFILE_COLUMNS)
    .eq('case_id', task.case_id);
  if (profileError) throw fromPostgresError(profileError);

  const coupleName = ((profiles ?? []) as unknown as CoupleProfileRow[])
    .slice()
    .sort((a, b) => Number(b.is_primary_contact) - Number(a.is_primary_contact))
    .map((profile) => readPii(profile.full_name))
    .filter((name) => name !== '')
    .join('・');

  // 「対応不要」（waived）にした宿題は確認の対象外。
  // API 側も 422 で弾くが（/api/submissions/{id}/review）、押せるボタンを出したまま
  // エラーで返すのは導線として不親切なので、フォーム自体を出さない（表6-9）。
  const isWaived = task.status === 'waived';
  const isPending = submission.review_status === 'submitted' && !isWaived;
  const textValue = readPii(submission.text_value);

  // ---------------------------------------------------------------- AI補助（7-2）
  // ワーカーの死活と、この宿題に紐づく最新ジョブ。
  // どれも取得に失敗したら null（＝出さない）に倒れるので、ここで例外にはならない。
  const [aiStatus, classificationJob, defectJob] = await Promise.all([
    fetchAiAssistStatus(supabase),
    latestJobForTask(supabase, task.id, 'classification'),
    latestJobForTask(supabase, task.id, 'defect_check'),
  ]);

  // 9-4 ①ルールベースは描画のたびにかけ直す（保存しない。submissionCheck.ts の冒頭を参照）。
  // 検査できない宿題（csvSchema 未設定・CSV以外）は null のままにして、欄ごと出さない。
  let ruleFindings: DefectFinding[] | null = null;
  const csvSchema = csvSchemaOf(task.options);
  if (csvSchema && submission.submission_type === 'file' && submission.storage_files) {
    const checked = await checkSubmittedCsv(supabase, {
      bucket: submission.storage_files.bucket,
      objectPath: submission.storage_files.object_path,
      fileName: submission.storage_files.original_filename,
      mimeType: submission.storage_files.mime_type,
    }, csvSchema);
    if (checked) ruleFindings = checked.findings;
  }

  return (
    <div>
      <nav aria-label="パンくず" className="mb-3">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/dashboard" className="text-link hover:underline">
              ダッシュボード
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href="/submissions" className="text-link hover:underline">
              提出物確認
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">{task.title}</li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="section-head">{task.title}</h1>
        <ReviewStatusBadge status={submission.review_status} />
      </div>
      <p className="mt-1 text-caption text-text-muted">
        {weddingCase.case_code}
        {coupleName && ` / ${coupleName} さま`}
      </p>

      <section className="card mt-4">
        <h2 className="text-label font-bold text-text-primary">提出内容</h2>
        <dl className="mt-2 grid gap-2 text-label text-text-secondary">
          <Row label="提出形式">{SUBMISSION_FORMAT_LABEL[submission.submission_type]}</Row>
          <Row label="提出日時">{formatDateTime(submission.submitted_at)}</Row>
          <Row label="宿題の期限">{formatDate(task.due_date)}</Row>
          <Row label="宿題の状態">
            <TaskStatusBadge status={task.status} />
          </Row>
        </dl>

        <div className="mt-3 border-t border-border-light pt-3">
          {submission.submission_type === 'text' && (
            <p className="whitespace-pre-wrap text-label text-text-primary">
              {textValue || '（入力なし）'}
            </p>
          )}

          {submission.submission_type === 'select' && (
            <p className="text-label text-text-primary">{submission.selected_value ?? '（未選択）'}</p>
          )}

          {submission.submission_type === 'file' &&
            (submission.storage_files ? (
              <SubmissionFileLink
                fileId={submission.storage_files.id}
                fileName={submission.storage_files.original_filename ?? '添付ファイル'}
              />
            ) : (
              <p className="text-label text-text-muted">添付ファイルは削除されています。</p>
            ))}

          {submission.submission_type === 'file' && submission.storage_files?.file_size_bytes && (
            <p className="mt-1 text-caption text-text-muted">
              {formatFileSize(submission.storage_files.file_size_bytes)}
            </p>
          )}

          {/* 6-7: submission_format='none'（確認のみ）も1行の提出として扱う */}
          {submission.submission_type === 'none' && (
            <p className="text-label text-text-primary">内容を確認した旨の報告を受け取りました。</p>
          )}

          {/* CSV 等の構造化提出内容。取り込み結果をそのまま確認できるようにしておく（5-3） */}
          {submission.content_json != null && (
            <pre className="table-wrap mt-3 max-h-64 overflow-auto p-3 text-caption text-text-secondary">
              {JSON.stringify(submission.content_json, null, 2)}
            </pre>
          )}
        </div>

        {submission.comment && (
          <div className="mt-3 border-t border-border-light pt-3">
            <p className="text-caption text-text-muted">新郎新婦からの補足</p>
            <p className="mt-1 whitespace-pre-wrap text-label text-text-primary">
              {submission.comment}
            </p>
          </div>
        )}
      </section>

      <ClassificationPanel initialJob={classificationJob} />

      <DefectPanel
        submissionId={submission.id}
        ruleFindings={ruleFindings}
        initialJob={defectJob}
        aiAvailable={aiStatus.available}
        lastSeenAt={aiStatus.lastSeenAt}
      />

      {isPending ? (
        <section className="card mt-4">
          <h2 className="text-label font-bold text-text-primary">確認結果を登録する</h2>
          <p className="mb-3 mt-1 text-caption text-text-muted">
            「不備あり」を選んだ場合は、どこを直していただきたいかをコメントに書いてください。
          </p>
          <ReviewForm
            submissionId={submission.id}
            caseId={task.case_id}
            taskId={task.id}
            taskTitle={task.title}
            aiAvailable={aiStatus.available}
            lastSeenAt={aiStatus.lastSeenAt}
          />
        </section>
      ) : (
        <section className="card mt-4">
          <h2 className="text-label font-bold text-text-primary">
            {isWaived ? 'この宿題は「対応不要」です' : '確認済みの内容'}
          </h2>
          <p className="mt-1 text-label text-text-secondary">
            {isWaived
              ? '案件詳細（K02）で「対応不要」に設定されているため、確認の必要はありません。'
                + '確認が必要な場合は、案件詳細で対応不要を解除してください。'
              : submission.reviewed_at
                ? `${formatDateTime(submission.reviewed_at)} に確認結果を登録しました。`
                : 'この提出はすでに確認が終わっています。'}
          </p>
          {submission.planner_feedback && (
            <p className="mt-2 whitespace-pre-wrap text-label text-text-primary">
              {submission.planner_feedback}
            </p>
          )}
          <div className="mt-3">
            <Link href={`/cases/${task.case_id}`} className="btn-ghost">
              案件詳細へ戻る
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-caption text-text-muted">{label}</dt>
      <dd className="text-text-primary">{children}</dd>
    </div>
  );
}
