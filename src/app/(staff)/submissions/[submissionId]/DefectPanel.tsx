/**
 * D02 の 9-4 提出物の不備一次チェック（Phase 3）。
 *
 * 正本: 基本設計書 7-2。
 *
 *   「9-4：ルール＋ローカルLLMで検出。『AIによる一次チェック（要確認）』として D02 に表示し、
 *     『不備あり』判定とコメント下書きを提示。確定判断・通知は必ずプランナー」
 *   「①ルールベース…はコードで実装する。②ローカルLLMは表記ゆれ候補と敬称の疑いのみを、
 *     該当行番号と確信度付きで提示する」
 *
 * ①の結果は Server Component から props で渡ってくる（描画のたびに毎回かけ直す）。
 * ②はこの画面のボタンから依頼する。ワーカーが止まっていても①は必ず出る、
 * という 7-2 の分割をそのまま画面にも出す。
 */
'use client';

import { useState } from 'react';

import { AiHeading, AiJobState, AiUnavailable } from '@/components/ai/AiNotice';
import { useAiJob, type AiJobView } from '@/components/ai/useAiJob';
import { FieldError } from '@/components/ui/ErrorSummary';
import { adoptedOutput } from '@/lib/ai/assist';
import type { DefectFinding } from '@/lib/ai/defectCheck';
import { DEFECT_TYPE_LABEL } from '@/lib/ai/schemas';
import { ApiCallError, api } from '@/lib/api/client';

interface Props {
  submissionId: string;
  /** ①ルールベースの指摘。null は「この宿題は検査対象外」（csvSchema 未設定・CSV以外） */
  ruleFindings: DefectFinding[] | null;
  initialJob: AiJobView | null;
  aiAvailable: boolean;
  lastSeenAt: string | null;
}

function FindingRow({ finding, source }: { finding: DefectFinding; source: string }) {
  return (
    <li className="border-b border-border-light py-2 last:border-b-0">
      <p className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
        <span className="badge-neutral">{DEFECT_TYPE_LABEL[finding.type]}</span>
        <span>{finding.row === 0 ? 'ファイル全体' : `${finding.row}行目`}</span>
        {finding.column && <span>{finding.column}</span>}
        <span>{source}</span>
        {finding.confidence < 1 && <span>確からしさ {Math.round(finding.confidence * 100)}%</span>}
      </p>
      <p className="mt-1 text-label text-text-primary">{finding.detail}</p>
    </li>
  );
}

export function DefectPanel({
  submissionId,
  ruleFindings,
  initialJob,
  aiAvailable,
  lastSeenAt,
}: Props) {
  const { job, setJob, track, timedOut } = useAiJob(initialJob);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 検査対象外の宿題では、この欄自体を出さない（テキスト提出に不備チェックは要らない）。
  if (ruleFindings === null) return null;

  async function requestCheck() {
    setError(null);
    setPending(true);
    try {
      const result = await api.post<{ jobId: string }>(
        `/api/submissions/${submissionId}/defect-check`,
      );
      track({
        id: result.jobId, status: 'queued', output: null, reviewed_output: null, error_message: null,
      });
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

  async function review(decision: 'confirmed' | 'discarded') {
    if (!job) return;
    setPending(true);
    setError(null);
    try {
      await api.patch(`/api/ai/jobs/${job.id}`, { decision });
      setJob({ ...job, status: decision });
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

  const llmFindings = adoptedOutput('defect_check', job)?.findings ?? [];
  const showLlm = job?.status === 'done' || job?.status === 'confirmed';

  return (
    <section className="card mt-4">
      <AiHeading note="機械的な確認の結果です。不備かどうかの判断と、新郎新婦へのご連絡はプランナーが行ってください。">
        AIによる一次チェック（要確認）
      </AiHeading>

      {/* ---- ①ルールベース。LLM の状態に関係なく必ず出る（7-2） ---- */}
      <div>
        <p className="text-caption text-text-muted">必須項目・重複・形式の確認</p>
        {ruleFindings.length === 0 ? (
          <p className="mt-1 text-label text-text-primary">
            必須項目・重複・形式の点で気になるところはありませんでした。
          </p>
        ) : (
          <ul className="mt-1">
            {ruleFindings.map((finding, i) => (
              <FindingRow key={`rule-${i}`} finding={finding} source="ルールによる確認" />
            ))}
          </ul>
        )}
      </div>

      {/* ---- ②ローカルLLM。表記ゆれ・敬称の「疑い」だけ（7-2） ---- */}
      <div className="mt-4 border-t border-border-light pt-3">
        <p className="text-caption text-text-muted">表記ゆれ・敬称の確認（AI）</p>

        {!aiAvailable && !showLlm && (
          <div className="mt-1">
            <AiUnavailable
              lastSeenAt={lastSeenAt}
              fallback="表記ゆれ・敬称は目視でご確認ください。上の確認結果はそのままご利用いただけます。"
            />
          </div>
        )}

        {job && (
          <div className="mt-1">
            <AiJobState
              status={job.status}
              errorMessage={job.error_message}
              fallback="表記ゆれ・敬称は目視でご確認ください。"
            />
          </div>
        )}

        {timedOut && (job?.status === 'queued' || job?.status === 'processing') && (
          <p className="mt-1 text-caption text-text-muted">
            時間がかかっています。画面を開き直すと最新の状態が表示されます。
          </p>
        )}

        {showLlm && (
          llmFindings.length === 0 ? (
            <p className="mt-1 text-label text-text-primary">
              表記ゆれ・敬称の疑いは挙がりませんでした。
            </p>
          ) : (
            <ul className="mt-1">
              {llmFindings.map((finding, i) => (
                <FindingRow key={`llm-${i}`} finding={finding} source="AIによる指摘" />
              ))}
            </ul>
          )
        )}

        <FieldError message={error ?? undefined} />

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          {aiAvailable && (!job || job.status === 'failed' || job.status === 'confirmed'
            || job.status === 'discarded') && (
            <button
              type="button"
              className="btn-secondary sm:w-64"
              disabled={pending}
              onClick={requestCheck}
            >
              {pending ? '依頼中…' : 'AIに表記ゆれ・敬称を見てもらう'}
            </button>
          )}
          {job?.status === 'done' && (
            <>
              <button
                type="button"
                className="btn-secondary sm:w-40"
                disabled={pending}
                onClick={() => review('confirmed')}
              >
                確認した
              </button>
              <button
                type="button"
                className="btn-secondary sm:w-32"
                disabled={pending}
                onClick={() => review('discarded')}
              >
                破棄する
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
