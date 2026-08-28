/**
 * D02 の 9-1 自由記述カテゴリ分類（Phase 3）。
 *
 * 正本: 基本設計書 7-2。
 *
 *   「9-1：分類結果は『AIによる分類（要確認）』として表示し、プランナーが修正できる」
 *   「ラベル集合は本書で確定し、画面（D02／K02）はこの列挙のみを扱う」
 *
 * ジョブは提出時にサーバー側から投入される（7-3）。この画面からは投入しない。
 * ここが担うのは「見せること」と「直して採用すること」だけ。
 *
 * 分類は業務データを変えない。宿題の状態も通知も動かさないので、
 * 採用しても破棄しても提出の確認作業には影響しない。
 */
'use client';

import { useState } from 'react';

import { AiHeading, AiJobState } from '@/components/ai/AiNotice';
import { useAiJob, type AiJobView } from '@/components/ai/useAiJob';
import { FieldError } from '@/components/ui/ErrorSummary';
import { adoptedOutput } from '@/lib/ai/assist';
import { CLASSIFICATION_LABELS, type ClassificationLabel } from '@/lib/ai/schemas';
import { ApiCallError, api } from '@/lib/api/client';

export function ClassificationPanel({ initialJob }: { initialJob: AiJobView | null }) {
  const { job, setJob, timedOut } = useAiJob(initialJob);
  const [selected, setSelected] = useState<ClassificationLabel[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 提出が自由記述でない、または古い提出でジョブが無い場合は何も出さない。
  if (!job) return null;
  const current = job;

  const output = adoptedOutput('classification', current);
  const labels = selected ?? output?.labels ?? [];

  function toggle(label: ClassificationLabel) {
    setSelected(
      labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label],
    );
  }

  async function review(decision: 'confirmed' | 'discarded') {
    setError(null);
    setPending(true);
    try {
      // 修正して採用する場合だけ output を送る。破棄には内容を付けない（7-2 の 9-1）。
      const revised = { labels, confidence: output?.confidence ?? 0 };
      await api.patch(
        `/api/ai/jobs/${current.id}`,
        decision === 'confirmed' ? { decision, output: revised } : { decision },
      );
      setJob({
        ...current,
        status: decision,
        reviewed_output: decision === 'confirmed' ? revised : null,
      });
      setSelected(null);
    } catch (cause) {
      setError(
        cause instanceof ApiCallError
          ? cause.message
          : '通信に失敗しました。時間をおいてお試しください',
      );
    } finally {
      setPending(false);
    }
  }

  const editable = current.status === 'done';

  return (
    <section className="card mt-4">
      <AiHeading note="この分類はAIが自動で付けたものです。内容をご確認のうえ、必要なら直してください。">
        AIによる分類（要確認）
      </AiHeading>

      <AiJobState
        status={current.status}
        errorMessage={current.error_message}
        fallback="分類が付かなくても、提出内容の確認はそのまま進められます。"
      />

      {timedOut && (current.status === 'queued' || current.status === 'processing') && (
        <p className="mt-2 text-caption text-text-muted">
          時間がかかっています。画面を開き直すと最新の状態が表示されます。
        </p>
      )}

      {(current.status === 'done' || current.status === 'confirmed') && (
        <>
          <div className="flex flex-wrap gap-2">
            {CLASSIFICATION_LABELS.map((label) => {
              const on = labels.includes(label);
              // 採用後は選び直せない。直したい場合は分類そのものを付け直す運用にする
              // （ここで自由に書き換えられると、何を根拠に確認したのかが残らない）。
              if (!editable) {
                return on ? (
                  <span key={label} className="badge-neutral">{label}</span>
                ) : null;
              }
              return (
                <label
                  key={label}
                  className={`badge cursor-pointer border ${
                    on ? 'border-primary bg-info-bg text-link' : 'border-border-light text-text-secondary'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => toggle(label)}
                  />
                  {label}
                </label>
              );
            })}
            {!editable && labels.length === 0 && (
              <span className="text-label text-text-muted">分類は付いていません。</span>
            )}
          </div>

          {output && editable && (
            <p className="mt-2 text-caption text-text-muted">
              AIの確からしさ: {Math.round(output.confidence * 100)}%
            </p>
          )}

          <FieldError message={error ?? undefined} />

          {editable && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="btn-secondary sm:w-44"
                disabled={pending || labels.length === 0}
                onClick={() => review('confirmed')}
              >
                この分類で確定する
              </button>
              <button
                type="button"
                className="btn-secondary sm:w-32"
                disabled={pending}
                onClick={() => review('discarded')}
              >
                破棄する
              </button>
            </div>
          )}

          {current.status === 'confirmed' && (
            <p className="mt-2 text-caption text-text-muted">確認済みの分類です。</p>
          )}
        </>
      )}
    </section>
  );
}
