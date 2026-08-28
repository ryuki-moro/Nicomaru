/**
 * D04 フォロー記録の入力（表4-16）。
 *
 *   実施日時: 日時・必須
 *   手段    : セレクト（電話／LINE／メール／打ち合わせ／その他）・必須
 *   メモ    : テキストエリア・任意・1000字上限
 *
 * 表示名は FOLLOW_METHOD_LABEL（表6-9）を唯一の対応表とする。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { api, handleApiError } from '@/lib/api/client';
import { FOLLOW_METHODS, FOLLOW_METHOD_LABEL, INPUT_LIMITS, type FollowMethod } from '@/lib/constants';

/**
 * <input type="datetime-local"> が受け取る現地時刻の書式（YYYY-MM-DDTHH:mm）。
 *
 * ここだけは format.ts の JST 固定ヘルパを使わない。datetime-local の値は
 * ブラウザの現地時刻として解釈され、送信時も new Date(値).toISOString() で
 * 現地時刻として UTC へ戻す。表示だけ JST に固定すると往復がずれるため、
 * 入力欄の初期値はブラウザの現地時刻で揃える。
 * （保存後の一覧表示は formatDateTime() が JST で描画する）
 */
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function FollowForm({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [followedAt, setFollowedAt] = useState(() => toLocalInputValue(new Date()));
  const [method, setMethod] = useState<FollowMethod>('phone');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSummaryError(null);
    setFieldErrors({});

    const parsed = new Date(followedAt);
    if (followedAt === '' || Number.isNaN(parsed.getTime())) {
      setFieldErrors({ followedAt: '実施日時を入力してください' });
      return;
    }

    setPending(true);
    try {
      // API は offset 付き ISO8601 を受け取る（followLogSchema）。
      // datetime-local は現地時刻でタイムゾーンを持たないため、ここで UTC の ISO へ正規化する。
      await api.post(`/api/cases/${caseId}/follow-logs`, {
        method,
        followedAt: parsed.toISOString(),
        note: note.trim() === '' ? null : note.trim(),
      });
      setNote('');
      setFollowedAt(toLocalInputValue(new Date()));
      router.refresh();
    } catch (error) {
      // 4-3 エラー表示規約: 権限エラー・不存在は P04 へ遷移する
      handleApiError(error, router, {
        onSummary: setSummaryError,
        onFieldErrors: setFieldErrors,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <ErrorSummary message={summaryError} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="followed-at" className="field-label">
            実施日時
          </label>
          <input
            id="followed-at"
            name="followedAt"
            type="datetime-local"
            className="field"
            value={followedAt}
            onChange={(event) => setFollowedAt(event.target.value)}
          />
          <FieldError message={fieldErrors.followedAt} />
        </div>

        <div>
          <label htmlFor="follow-method" className="field-label">
            手段
          </label>
          <select
            id="follow-method"
            name="method"
            className="field"
            value={method}
            onChange={(event) => setMethod(event.target.value as FollowMethod)}
          >
            {FOLLOW_METHODS.map((value) => (
              <option key={value} value={value}>
                {FOLLOW_METHOD_LABEL[value]}
              </option>
            ))}
          </select>
          <FieldError message={fieldErrors.method} />
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor="follow-note" className="field-label">
          メモ（任意）
        </label>
        <textarea
          id="follow-note"
          name="note"
          rows={4}
          className="field"
          maxLength={INPUT_LIMITS.textArea}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="話した内容や、次にご案内する予定などをご記入ください"
        />
        <p className="mt-1 text-caption text-text-muted">
          {note.length} / {INPUT_LIMITS.textArea}字
        </p>
        <FieldError message={fieldErrors.note} />
      </div>

      <div className="mt-4">
        <button type="submit" className="btn-primary sm:w-40" disabled={pending}>
          {pending ? '記録中…' : '記録する'}
        </button>
      </div>
    </form>
  );
}
