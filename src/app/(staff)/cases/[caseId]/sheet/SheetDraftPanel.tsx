/**
 * D03 の 9-2 準備シート要点下書き（Phase 3）。
 *
 * 正本: 基本設計書 7-2／4-3 D03。
 *
 *   「9-2 準備シート下書き生成｜入力: 提出済・未提出・連絡履歴・打ち合わせ記録｜
 *     出力: 要点下書き（draft）｜画面: D03」
 *   「AI補助（9-2 要点下書き）を利用可」
 *
 * 依頼はサーバーアクション（page.tsx の requestSheetDraft）が行う。
 * LLM へ渡す内容をサーバー側で組み立てるため、この画面は文言を一切送らない（7-4）。
 *
 * ここが持つのは (1) 生成待ちの監視 (2) 採用・破棄 の2つだけ。
 * 採用すると印刷対象のシート本体に載る（page.tsx 側）。
 * 採用前の下書きを紙に出さないのは、確認を経ていない文章が
 * 打ち合わせの資料として一人歩きしないようにするため（7-1）。
 */
'use client';

import { useState } from 'react';

import { AiHeading, AiJobState, AiUnavailable } from '@/components/ai/AiNotice';
import { useAiJob, type AiJobView } from '@/components/ai/useAiJob';
import { FieldError } from '@/components/ui/ErrorSummary';
import { adoptedOutput } from '@/lib/ai/assist';
import { ApiCallError, api } from '@/lib/api/client';

interface Props {
  initialJob: AiJobView | null;
  aiAvailable: boolean;
  lastSeenAt: string | null;
  /** 依頼ボタン（サーバーアクションの form）。押した結果はページの再描画で反映される */
  requestSlot: React.ReactNode;
}

export function SheetDraftPanel({ initialJob, aiAvailable, lastSeenAt, requestSlot }: Props) {
  const { job, setJob, timedOut } = useAiJob(initialJob);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review(decision: 'confirmed' | 'discarded') {
    if (!job) return;
    setPending(true);
    setError(null);
    try {
      await api.patch(`/api/ai/jobs/${job.id}`, { decision });
      setJob({ ...job, status: decision });
      // 採用するとシート本体（印刷対象）に載る。載せ替えはサーバー側の描画に任せる。
      if (decision === 'confirmed') window.location.reload();
    } catch (cause) {
      setError(
        cause instanceof ApiCallError
          ? cause.message
          : '通信に失敗しました。時間をおいてお試しください',
      );
      setPending(false);
    }
  }

  const output = adoptedOutput('draft', job);
  const idle = !job || job.status === 'failed' || job.status === 'discarded'
    || job.status === 'confirmed';

  return (
    <section className="card">
      <AiHeading note="打ち合わせで触れる点の下書きです。内容を確かめてから、シートに載せてください。">
        AIによる要点の下書き（要確認）
      </AiHeading>

      {!aiAvailable && idle && (
        <AiUnavailable
          lastSeenAt={lastSeenAt}
          fallback="下書きが無くても、シートの内容はそのまま印刷できます。"
        />
      )}

      {job && (
        <AiJobState
          status={job.status}
          errorMessage={job.error_message}
          fallback="シートの内容はそのまま印刷できます。"
        />
      )}

      {timedOut && (job?.status === 'queued' || job?.status === 'processing') && (
        <p className="text-caption text-text-muted">
          時間がかかっています。画面を開き直すと最新の状態が表示されます。
        </p>
      )}

      {output && job?.status === 'done' && (
        <div>
          <p className="whitespace-pre-wrap rounded-field border border-border-light bg-bg px-3 py-2 text-label text-text-primary">
            {output.text}
          </p>
          {output.cautions.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-caption text-text-muted">
              {output.cautions.map((caution, i) => (
                <li key={i}>{caution}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {job?.status === 'confirmed' && (
        <p className="text-label text-text-secondary">
          下書きをシートに載せました。内容はシート本体でご確認ください。
        </p>
      )}

      <FieldError message={error ?? undefined} />

      <div className="mt-3 flex flex-wrap gap-3">
        {aiAvailable && idle && requestSlot}
        {job?.status === 'done' && (
          <>
            <button
              type="button"
              className="btn-secondary w-auto px-5"
              disabled={pending}
              onClick={() => review('confirmed')}
            >
              シートに載せる
            </button>
            <button
              type="button"
              className="btn-secondary w-auto px-5"
              disabled={pending}
              onClick={() => review('discarded')}
            >
              破棄する
            </button>
          </>
        )}
      </div>
    </section>
  );
}
