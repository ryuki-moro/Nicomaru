'use client';

/**
 * LINE アカウント連携の実行（6-10 手順(3)）。
 *
 * サーバーで nonce を発行し、返ってきた LINE のアカウント連携ダイアログへ遷移する。
 * nonce は平文をこの応答でしか受け取らないため、状態に保持せずそのまま遷移に使う。
 */
import { useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';

export function LineLinkButton({ linkToken }: { linkToken: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setError(null);
    setPending(true);
    try {
      const { url } = await api.post<{ url: string }>('/api/line/link', { linkToken });
      window.location.href = url;
    } catch (e) {
      setError(e instanceof ApiCallError
        ? e.message
        : '連携の準備ができませんでした。時間をおいてお試しください');
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <ErrorSummary message={error} />
      <button type="button" className="btn-primary" disabled={pending} onClick={link}>
        {pending ? '連携の準備中…' : '公式LINEと連携する'}
      </button>
    </div>
  );
}
