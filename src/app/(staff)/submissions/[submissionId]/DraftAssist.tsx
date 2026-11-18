/**
 * D02 の 9-3 通知・コメント文面の下書き（Phase 3）。
 *
 * 正本: 基本設計書 7-2／7-1／付録D。
 *
 *   「9-3 通知・コメント文面下書き｜入力: 不備内容・フォロー文脈｜出力: 文面下書き（draft）｜画面: D02」
 *   「出力は必ずプランナーの確認を経て利用する（自動送信・自動登録は行わない）」
 *
 * 下書きはコメント欄に**入れるだけ**で、送信はしない。
 * 入れたあとにプランナーが直せる状態で渡すのが 7-1 の「確認を経て利用する」に当たる。
 *
 * LLM へ渡すのはプランナーが書いた要点と宿題名だけ（7-4 の入力最小化）。
 * 提出本文や新郎新婦の氏名は渡さない。文面の宛名はテンプレート側で埋める。
 */
'use client';

import { useState } from 'react';

import {
  AiHeading,
  AiJobState,
  AiOutcomeTombstone,
  AiTimeoutNotice,
  AiUnavailable,
} from '@/components/ai/AiNotice';
import { useAiJob } from '@/components/ai/useAiJob';
import { FieldError } from '@/components/ui/ErrorSummary';
import { adoptedOutput } from '@/lib/ai/assist';
import { ApiCallError, api } from '@/lib/api/client';
import { INPUT_LIMITS, type ReviewDecision } from '@/lib/constants';

interface Props {
  caseId: string;
  taskId: string;
  taskTitle: string;
  /** 確認結果。未選択のうちは依頼させない（文面の方向が決まらないため） */
  decision: ReviewDecision | null;
  /** プランナーが書いた要点。これが下書きの元になる */
  memo: string;
  /** 一次チェックの指摘。「不備あり」のときは要点が空でもこれを材料に下書きできる */
  defectNotes: string[];
  aiAvailable: boolean;
  lastSeenAt: string | null;
  onAdopt: (text: string) => void;
}

/** 指摘が多いCSVでも依頼の入力上限を超えないよう、収まる分だけ並べて残りは件数で示す */
function listWithinLimit(notes: string[], maxChars = 1500): string {
  const lines: string[] = [];
  let length = 0;
  for (const note of notes) {
    const line = `- ${note}`;
    if (length + line.length + 1 > maxChars) break;
    lines.push(line);
    length += line.length + 1;
  }
  const rest = notes.length - lines.length;
  return rest > 0 ? `${lines.join('\n')}\n- ほか${rest}件` : lines.join('\n');
}

export function DraftAssist({
  caseId,
  taskId,
  taskTitle,
  decision,
  memo,
  defectNotes,
  aiAvailable,
  lastSeenAt,
  onAdopt,
}: Props) {
  const notes = decision === 'needs_fix' ? defectNotes : [];
  const { job, track, setJob, timedOut } = useAiJob(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** コメント欄に入力済みの文章がある状態で採用するときの上書き確認 */
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);

  async function request() {
    setError(null);
    setPending(true);
    try {
      const situation =
        decision === 'needs_fix'
          ? '提出内容に直していただきたい点があります'
          : '提出内容を確認しました';
      const created = await api.post<{ id: string }>('/api/ai/jobs', {
        caseId,
        jobType: 'draft',
        relatedTaskId: taskId,
        input: {
          text: [
            `宿題: ${taskTitle}`,
            `状況: ${situation}`,
            memo.trim() && `伝えたいこと: ${memo.trim()}`,
            notes.length > 0 && `直していただきたい箇所:\n${listWithinLimit(notes)}`,
          ]
            .filter(Boolean)
            .join('\n'),
          params: { purpose: 'submission_review_comment' },
        },
      });
      track({
        id: created.id,
        status: 'queued',
        output: null,
        reviewed_output: null,
        error_message: null,
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

  function handleAdoptClick() {
    const output = adoptedOutput('draft', job);
    if (!output) return;
    // コメント欄には下書きの元になった要点が入力されていることが多い。
    // 無確認で置き換えるとプランナーの文章が消えるため、入力済みなら確認を挟む。
    if (memo.trim() !== '' && memo.trim() !== output.text.trim()) {
      setConfirmingOverwrite(true);
      return;
    }
    void adopt();
  }

  async function adopt() {
    if (!job) return;
    const output = adoptedOutput('draft', job);
    if (!output) return;
    setPending(true);
    try {
      // 採用の記録を残してからコメント欄へ入れる（7-3）。
      // 記録に失敗しても文面は渡す。下書きを入れること自体は業務上の副作用が無い。
      await api.patch(`/api/ai/jobs/${job.id}`, { decision: 'confirmed' }).catch(() => undefined);
      setJob({ ...job, status: 'confirmed' });
      setConfirmingOverwrite(false);
      onAdopt(output.text.slice(0, INPUT_LIMITS.textArea));
    } finally {
      setPending(false);
    }
  }

  async function discard() {
    if (!job) return;
    setPending(true);
    try {
      await api.patch(`/api/ai/jobs/${job.id}`, { decision: 'discarded' }).catch(() => undefined);
      setJob({ ...job, status: 'discarded' });
      setConfirmingOverwrite(false);
    } finally {
      setPending(false);
    }
  }

  const output = adoptedOutput('draft', job);
  const canRequest = decision !== null && (memo.trim() !== '' || notes.length > 0);

  return (
    <div className="mb-4 rounded-card border border-border-light bg-bg px-3 py-3">
      <AiHeading note="AIが作った下書きです。コメント欄に入れたあと、必ずご自身の言葉で確認・修正してください。">
        AIによる下書き（要確認）
      </AiHeading>

      {!aiAvailable && !output && (
        <AiUnavailable
          lastSeenAt={lastSeenAt}
          fallback="下書きは使えませんが、コメントはそのまま手入力で登録できます。"
        />
      )}

      {job && (
        <AiJobState
          status={job.status}
          errorMessage={job.error_message}
          fallback="コメントは手入力で登録できます。"
          onRetry={job.status === 'failed' && canRequest ? request : undefined}
        />
      )}

      {timedOut && (job?.status === 'queued' || job?.status === 'processing') && (
        <AiTimeoutNotice />
      )}

      {output && (
        <div className="mt-1">
          <p className="whitespace-pre-wrap rounded-field border border-border-light bg-surface px-3 py-2 text-label text-text-primary">
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

      <FieldError message={error ?? undefined} />

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {aiAvailable && (
          <button
            type="button"
            className="btn-secondary sm:w-56"
            disabled={pending || !canRequest}
            onClick={request}
          >
            {pending ? '依頼中…' : 'AIに文面の下書きを頼む'}
          </button>
        )}
        {job?.status === 'done' && output && (
          <>
            <button
              type="button"
              className="btn-primary sm:w-48"
              disabled={pending}
              onClick={handleAdoptClick}
            >
              下書きを採用する
            </button>
            <button
              type="button"
              className="btn-ghost sm:w-32"
              disabled={pending}
              onClick={discard}
            >
              破棄する
            </button>
          </>
        )}
      </div>

      {confirmingOverwrite && job?.status === 'done' && output && (
        <div className="banner-error mt-3" role="alert">
          <div>
            <p>
              コメント欄には入力済みの文章があります。下書きを採用すると、その文章が下書きの内容に置き換わります。よろしいですか？
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="btn-primary sm:w-40"
                disabled={pending}
                onClick={adopt}
              >
                置き換える
              </button>
              <button
                type="button"
                className="btn-ghost sm:w-32"
                disabled={pending}
                onClick={() => setConfirmingOverwrite(false)}
              >
                やめる
              </button>
            </div>
          </div>
        </div>
      )}

      {job?.status === 'confirmed' && <AiOutcomeTombstone status="confirmed" />}

      {!canRequest && aiAvailable && (
        <p className="mt-2 text-caption text-text-muted">
          確認結果を選び、伝えたいことをコメント欄に書いてから依頼してください。
        </p>
      )}
      {notes.length > 0 && !job && (
        <p className="mt-2 text-caption text-text-muted">
          一次チェックの指摘{notes.length}件（行番号つき）を材料に下書きします。
        </p>
      )}
    </div>
  );
}
