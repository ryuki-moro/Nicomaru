/**
 * M03 宿題詳細・提出のフォーム部分。
 *
 * 正本: 基本設計書 Version 1.2 4-3「M03 宿題詳細・提出」表4-13 および 3-3-3。
 *   - 表示する項目は case_tasks.submission_format に従う（text／select／file／none）。
 *   - ボタンは「提出する」「一時保存」「戻る」。submission_format='none' の宿題は
 *     入力欄を出さず、ラベルを「確認しました」とした1ボタンのみにする。
 *   - 入力検証エラーは項目直下、APIエラーはフォーム上部にサマリ表示する（4-3 エラー表示規約）。
 *
 * ここでの検証は体感速度のための一次チェックにすぎず、
 * 受理可否の判断はすべてサーバー側（/api/tasks/{taskId}/submit・/api/files/upload）が行う。
 */
'use client';

import { useState } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, ApiCallError, handleApiError, type ApiErrorBody } from '@/lib/api/client';
import {
  FILE_TYPE_MIME,
  INPUT_LIMITS,
  type AllowedFileType,
  type SubmissionFormat,
} from '@/lib/constants';

interface Props {
  taskId: string;
  submissionFormat: SubmissionFormat;
  /** case_tasks.options.choices（select のみ） */
  choices: string[];
  /** case_tasks.allowed_file_types（file のみ） */
  allowedFileTypes: AllowedFileType[];
  defaultText: string;
  defaultSelected: string;
  defaultComment: string;
  /** 既存提出の添付。差し替えなければそのまま引き継ぐ */
  defaultFileId: string | null;
  defaultFileName: string | null;
  /** 「提出する」のラベル。none の宿題では「確認しました」になる */
  submitLabel: string;
  /**
   * 一時保存を出すか。提出済み（review_status='submitted'）の内容を draft へ戻すと
   * case_tasks.status と食い違うため、その場合は出さない（サーバー側も 422 で拒否する）。
   */
  canSaveDraft: boolean;
}

/** 拡張子の正規化。サーバー側 /api/files/upload と同じ規則にそろえる。 */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = filename.slice(dot + 1).toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

function validateFile(file: File, allowed: AllowedFileType[]): string | null {
  if (file.size > INPUT_LIMITS.fileBytes) return 'ファイルは1件5MBまでにしてください';
  if (!allowed.includes(extensionOf(file.name) as AllowedFileType)) {
    return `${allowed.join('・')} のファイルを選んでください`;
  }
  return null;
}

/**
 * 提出ファイルの送信。multipart のため api.post（JSON専用）ではなく fetch を直接使うが、
 * エラーは 6-5-1 の形式で受け取り ApiCallError に揃える。
 */
async function uploadFile(taskId: string, file: File): Promise<string> {
  const form = new FormData();
  form.append('taskId', taskId);
  form.append('file', file);

  const response = await fetch('/api/files/upload', { method: 'POST', body: form });
  const text = await response.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!response.ok) {
    const body = (json as { error?: ApiErrorBody }).error ?? {
      code: 'INTERNAL_ERROR' as const,
      message: 'ファイルを送信できませんでした。時間をおいてお試しください',
      details: [],
    };
    throw new ApiCallError(body, response.status);
  }
  return (json as { fileId: string }).fileId;
}

export function SubmitForm({
  taskId,
  submissionFormat,
  choices,
  allowedFileTypes,
  defaultText,
  defaultSelected,
  defaultComment,
  defaultFileId,
  defaultFileName,
  submitLabel,
  canSaveDraft,
}: Props) {
  const router = useRouter();
  const [text, setText] = useState(defaultText);
  const [selected, setSelected] = useState(defaultSelected);
  const [comment, setComment] = useState(defaultComment);
  const [file, setFile] = useState<File | null>(null);
  const [fileId, setFileId] = useState<string | null>(defaultFileId);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function send(draft: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setFieldErrors({});

    try {
      let attachedId = fileId;
      if (submissionFormat === 'file' && file) {
        const localError = validateFile(file, allowedFileTypes);
        if (localError) {
          setFieldErrors({ file: localError });
          return;
        }
        attachedId = await uploadFile(taskId, file);
        setFileId(attachedId);
        setFile(null);
      }

      await api.post(`/api/tasks/${taskId}/submit`, {
        submissionType: submissionFormat,
        textValue: submissionFormat === 'text' ? text : null,
        selectedValue: submissionFormat === 'select' ? selected : null,
        fileId: submissionFormat === 'file' ? attachedId : null,
        comment: comment.trim() || null,
        draft,
      });

      if (draft) {
        // 一時保存はその場に留まる。保存済みの内容をサーバーから取り直す。
        setNotice('入力中の内容を保存しました。あとから続きを入力できます。');
        router.refresh();
      } else {
        router.push('/mypage/tasks');
        router.refresh();
      }
    } catch (caught) {
      // 4-3 エラー表示規約: 権限エラー・不存在は P04 へ遷移する。
      // プランナーが宿題を「対応不要」にした直後の提出などがここに来る。
      handleApiError(caught, router, {
        onSummary: setError,
        onFieldErrors: setFieldErrors,
      });
    } finally {
      setBusy(false);
    }
  }

  // 受入形式から accept を組み立てる。拡張子と MIME の両方を並べる。
  const accept = allowedFileTypes
    .flatMap((type) => [`.${type}`, ...FILE_TYPE_MIME[type]])
    .join(',');

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void send(false);
      }}
      className="flex flex-col gap-3"
    >
      <ErrorSummary message={error} />
      {notice && (
        <div role="status" className="banner-info">
          <span>{notice}</span>
        </div>
      )}

      {submissionFormat === 'text' && (
        <div>
          <label className="field-label" htmlFor="answer-text">
            回答
          </label>
          <textarea
            id="answer-text"
            className="field min-h-32"
            maxLength={INPUT_LIMITS.answerText}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-invalid={fieldErrors.textValue ? true : undefined}
          />
          <p className="mt-1 text-right text-caption text-text-muted">
            {text.length} / {INPUT_LIMITS.answerText}
          </p>
          <FieldError message={fieldErrors.textValue} />
        </div>
      )}

      {submissionFormat === 'select' && (
        <fieldset>
          <legend className="field-label">回答</legend>
          <div className="flex flex-col gap-2">
            {choices.map((choice) => (
              <label key={choice} className="card flex items-center gap-3 text-base">
                <input
                  type="radio"
                  name="answer-choice"
                  value={choice}
                  checked={selected === choice}
                  onChange={() => setSelected(choice)}
                  className="accent-primary"
                />
                <span>{choice}</span>
              </label>
            ))}
          </div>
          <FieldError message={fieldErrors.selectedValue} />
        </fieldset>
      )}

      {submissionFormat === 'file' && (
        <div>
          <label className="field-label" htmlFor="answer-file">
            添付ファイル（{allowedFileTypes.join('・')}／1件5MBまで）
          </label>
          <input
            id="answer-file"
            type="file"
            accept={accept}
            className="field"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            aria-invalid={fieldErrors.file || fieldErrors.fileId ? true : undefined}
          />
          {!file && defaultFileName && (
            <p className="mt-1 text-caption text-text-muted">
              現在の添付: {defaultFileName}（選び直さなければこのまま提出されます）
            </p>
          )}
          {allowedFileTypes.includes('csv') && (
            <p className="mt-1 text-caption text-text-muted">
              CSVは UTF-8 で保存してください。
            </p>
          )}
          <FieldError message={fieldErrors.file ?? fieldErrors.fileId} />
        </div>
      )}

      {submissionFormat !== 'none' && (
        <div>
          <label className="field-label" htmlFor="answer-comment">
            補足（任意）
          </label>
          <textarea
            id="answer-comment"
            className="field min-h-20"
            maxLength={INPUT_LIMITS.textArea}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            aria-invalid={fieldErrors.comment ? true : undefined}
          />
          <FieldError message={fieldErrors.comment} />
        </div>
      )}

      <div className="mt-1 flex flex-col gap-[10px]">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? '送信中…' : submitLabel}
        </button>
        {/* 確認のみの宿題には保存すべき入力が無いので一時保存を出さない（表4-13） */}
        {submissionFormat !== 'none' && canSaveDraft && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void send(true)}
          >
            一時保存
          </button>
        )}
        <Link href="/mypage/tasks" className="btn-ghost self-center">
          戻る
        </Link>
      </div>
    </form>
  );
}
