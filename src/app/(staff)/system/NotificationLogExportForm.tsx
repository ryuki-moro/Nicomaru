'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { ApiCallError, handleApiError } from '@/lib/api/client';

const EXPORT_PATH = '/api/system/notification-logs.csv';

export function NotificationLogExportForm() {
  const router = useRouter();
  const downloading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  async function download(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (downloading.current) return;
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const field of ['from', 'to']) {
      const value = form.get(field);
      if (typeof value === 'string' && value !== '') params.set(field, value);
    }

    downloading.current = true;
    setBusy(true);
    setSummary(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const query = params.toString();
      const response = await fetch(query ? `${EXPORT_PATH}?${query}` : EXPORT_PATH, {
        cache: 'no-store',
      });
      if (!response.ok) {
        let body: unknown;
        try {
          const json: unknown = await response.json();
          if (typeof json === 'object' && json !== null && 'error' in json) body = json.error;
        } catch {
          // HTMLなどのエラー本文でもstatusを保持し、401/403/404の共通遷移へ渡す。
        }
        throw new ApiCallError(body, response.status);
      }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/csv')) {
        throw new Error('CSV以外の応答が返されました');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'notification-logs.csv';
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        // ブラウザがダウンロードを開始してから、不要になったURLを解放する。
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setNotice(
        response.headers.get('x-truncated') === 'true'
          ? '対象が10,000件を超えたため、最新10,000件を出力しました。すべて取得する場合は期間を絞って再度出力してください。'
          : 'CSVのダウンロードを開始しました。',
      );
    } catch (error) {
      handleApiError(error, router, { onSummary: setSummary, onFieldErrors: setFieldErrors });
    } finally {
      downloading.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      aria-label="通知ログCSV出力"
      aria-busy={busy}
      className="card mt-3 space-y-3"
      onSubmit={download}
      noValidate
    >
      <p id="notification-log-period-help" className="text-caption text-text-secondary">
        期間は日本時間で指定します。終了日当日のログも含みます。未指定の場合は期間を絞りません。
      </p>
      <p className="text-caption text-text-secondary">
        対象の最新10,000件を出力します。通知本文・氏名・メールアドレスなどの個人情報は含みません。
      </p>
      <ErrorSummary message={summary} />
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="notification-log-from" className="field-label">
            開始日（任意）
          </label>
          <input
            id="notification-log-from"
            name="from"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            className="field"
            aria-invalid={fieldErrors.from ? true : undefined}
            aria-describedby="notification-log-period-help notification-log-from-error"
          />
          <div id="notification-log-from-error">
            <FieldError message={fieldErrors.from} />
          </div>
        </div>
        <div>
          <label htmlFor="notification-log-to" className="field-label">
            終了日（任意）
          </label>
          <input
            id="notification-log-to"
            name="to"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            className="field"
            aria-invalid={fieldErrors.to ? true : undefined}
            aria-describedby="notification-log-period-help notification-log-to-error"
          />
          <div id="notification-log-to-error">
            <FieldError message={fieldErrors.to} />
          </div>
        </div>
      </fieldset>
      <button type="submit" className="btn-secondary w-auto" disabled={busy}>
        {busy ? '取得中…' : 'ログをCSV出力'}
      </button>
      {notice && (
        <p role="status" className="banner-info">
          {notice}
        </p>
      )}
    </form>
  );
}
