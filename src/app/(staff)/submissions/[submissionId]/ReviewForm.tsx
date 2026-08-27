/**
 * D02 の対話部分（表4-15）。Server Component から切り出したクライアント側。
 *
 *   確認ステータス: ラジオ（確認済／不備あり）必須
 *   コメント      : 不備あり時必須・1000字上限
 *
 * AI補助（9-3 コメント下書き／9-4 不備一次チェック）は Phase 3 のため参考表示欄を作らない。
 * 添付ファイルの署名付きURL取得も同じ画面の対話操作なので本ファイルにまとめている。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import { INPUT_LIMITS, REVIEW_DECISIONS, REVIEW_STATUS_LABEL, type ReviewDecision } from '@/lib/constants';

interface Props {
  submissionId: string;
  /** 「確定する」「キャンセル」いずれも K02 案件詳細へ戻る（4-3 D02） */
  caseId: string;
}

export function ReviewForm({ submissionId, caseId }: Props) {
  const router = useRouter();
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSummaryError(null);
    setFieldErrors({});

    // 送信前の入力チェック（4-3 エラー表示規約。サーバー側でも同じ規則を再検証する）
    if (!decision) {
      setFieldErrors({ decision: '確認結果を選択してください' });
      return;
    }
    if (decision === 'needs_fix' && comment.trim() === '') {
      setFieldErrors({ comment: '不備の内容を入力してください' });
      return;
    }

    setPending(true);
    try {
      await api.post(`/api/submissions/${submissionId}/review`, {
        decision,
        comment: comment.trim() === '' ? null : comment.trim(),
      });
      router.push(`/cases/${caseId}`);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiCallError) {
        setSummaryError(error.message);
        setFieldErrors(error.fieldErrors);
      } else {
        setSummaryError('通信に失敗しました。時間をおいてお試しください');
      }
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <ErrorSummary message={summaryError} />

      <fieldset className="mb-4">
        <legend className="field-label">確認結果</legend>
        <div className="flex flex-wrap gap-4">
          {REVIEW_DECISIONS.map((value) => (
            <label key={value} className="flex items-center gap-2 text-label text-text-primary">
              <input
                type="radio"
                name="decision"
                value={value}
                checked={decision === value}
                onChange={() => setDecision(value)}
                className="accent-primary"
              />
              {/* 表示名は表6-9 に従う（画面で独自の文言を作らない） */}
              {REVIEW_STATUS_LABEL[value]}
            </label>
          ))}
        </div>
        <FieldError message={fieldErrors.decision} />
      </fieldset>

      <div className="mb-4">
        <label htmlFor="review-comment" className="field-label">
          コメント{decision === 'needs_fix' ? '（必須）' : '（任意）'}
        </label>
        <textarea
          id="review-comment"
          name="comment"
          rows={5}
          maxLength={INPUT_LIMITS.textArea}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          className="field"
          placeholder="直していただきたい点や、お礼のひとことをご記入ください"
        />
        <p className="mt-1 text-caption text-text-muted">
          {comment.length} / {INPUT_LIMITS.textArea}字
        </p>
        <FieldError message={fieldErrors.comment} />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <button type="submit" className="btn-primary sm:w-40" disabled={pending}>
          {pending ? '送信中…' : '確定する'}
        </button>
        <button
          type="button"
          className="btn-secondary sm:w-40"
          disabled={pending}
          onClick={() => router.push(`/cases/${caseId}`)}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}

/**
 * 提出ファイルのダウンロード（6-5 表6-6 /api/files/{fileId}/download）。
 * 署名付きURLは TTL 60秒・都度発行のため、ページに URL を焼き込まずクリック時に取得する。
 */
export function SubmissionFileLink({
  fileId,
  fileName,
}: {
  fileId: string;
  fileName: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setPending(true);
    try {
      const { url } = await api.get<{ url: string }>(`/api/files/${fileId}/download`);
      // await のあとの window.open はポップアップブロックに掛かることがあるため、
      // アンカーの programmatic click で開く。
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) {
      setError(
        cause instanceof ApiCallError
          ? cause.message
          : 'ファイルを取得できませんでした。時間をおいてお試しください',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn-ghost" onClick={handleClick} disabled={pending}>
        {pending ? '準備中…' : `${fileName} を開く`}
      </button>
      <FieldError message={error ?? undefined} />
    </div>
  );
}
