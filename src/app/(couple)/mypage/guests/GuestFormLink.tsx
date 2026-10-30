'use client';

/**
 * ゲスト向け回答URLの表示・コピー・切り替え。
 * 切り替えると前のURLは使えなくなるため、その場で確認を挟む
 * （window.confirm は E2E で扱いにくいので使わない。TaskSection と同じ）。
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';

export function GuestFormLink({ caseId, url }: { caseId: string; url: string | null }) {
  const router = useRouter();
  const [current, setCurrent] = useState(url);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const issue = async () => {
    const switching = current !== null;
    setPending(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.post<{ url: string }>(`/api/cases/${caseId}/guest-form`, {});
      setCurrent(result.url);
      setConfirming(false);
      setNote(
        switching ? '新しいURLに切り替えました。前のURLは使えません。' : 'URLを発行しました。',
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiCallError ? cause.message : 'URLを発行できませんでした。');
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current);
      setNote('コピーしました。');
    } catch {
      setNote('コピーできませんでした。URLを長押しして手動でコピーしてください。');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorSummary message={error} />
      {note && (
        <div role="status" className="banner-info">
          <span>{note}</span>
        </div>
      )}

      {current ? (
        <>
          <input
            readOnly
            value={current}
            aria-label="ゲスト向け回答URL"
            className="field font-mono text-caption"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={copy}>
              コピー
            </button>
            <a
              className="btn-secondary text-center"
              href={`https://line.me/R/msg/text/?${encodeURIComponent(
                `結婚式のご出欠を、こちらからご回答ください。\n${current}`,
              )}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              LINEで送る
            </a>
          </div>
          {confirming ? (
            <div className="rounded-card border border-border-mid p-3">
              <p className="text-label text-text-primary">
                {'新しいURLに切り替えますか？' +
                  'すでにお送りしたURLからは回答できなくなります（これまでの回答は残ります）。'}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={pending}
                  onClick={() => void issue()}
                >
                  切り替える
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn-ghost self-start text-caption"
              onClick={() => setConfirming(true)}
            >
              URLを切り替える
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          className="btn-primary"
          disabled={pending}
          onClick={() => void issue()}
        >
          回答URLを発行する
        </button>
      )}
    </div>
  );
}
