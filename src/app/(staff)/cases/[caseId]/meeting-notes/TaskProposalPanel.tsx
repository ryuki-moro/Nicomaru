/**
 * D05 の 9-5 宿題起票案（Phase 3）。
 *
 * 正本: 基本設計書 7-2／4-3 D05。
 *
 *   「9-5：抽出した起票案（宿題名・説明・期限の目安）を提示し、
 *     プランナーが承認・修正した案のみ case_tasks として登録（自動登録なし）」
 *   「AI（9-5）が抽出した宿題起票案を『AIによる起票案（要確認）』として提示」
 *
 * 【自動登録しないことの実装】
 * この画面は案を「フォームの初期値」として出すだけで、登録は
 * 既存の POST /api/cases/{caseId}/tasks（機能5-5）をそのまま使う。
 * AI 専用の登録経路を作らないので、AI 由来かどうかに関わらず
 * 宿題の作られ方は1つに保たれる。
 *
 * 期限は AI に決めさせない。due_hint（「挙式2か月前ごろ」など）は目安として見せるだけで、
 * 実際の期限はプランナーが日付で入力する（7-2 の「期限の目安」）。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { AiHeading, AiJobState, AiUnavailable } from '@/components/ai/AiNotice';
import { useAiJob, type AiJobView } from '@/components/ai/useAiJob';
import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { adoptedOutput } from '@/lib/ai/assist';
import { ApiCallError, api } from '@/lib/api/client';
import { INPUT_LIMITS } from '@/lib/constants';

interface Props {
  caseId: string;
  initialJob: AiJobView | null;
  aiAvailable: boolean;
  lastSeenAt: string | null;
}

interface Proposal {
  title: string;
  description: string;
  dueHint: string;
  dueDate: string;
  registered: boolean;
}

export function TaskProposalPanel({ caseId, initialJob, aiAvailable, lastSeenAt }: Props) {
  const router = useRouter();
  const { job, setJob, timedOut } = useAiJob(initialJob);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<number, string>>({});

  const output = adoptedOutput('task_extraction', job);
  // 生成結果を編集可能な形へ写す。ジョブが差し替わったら作り直す。
  const rows: Proposal[] = proposals ?? (output?.tasks ?? []).map((task) => ({
    title: task.title,
    description: task.description,
    dueHint: task.due_hint,
    dueDate: '',
    registered: false,
  }));

  function update(index: number, patch: Partial<Proposal>) {
    setProposals(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function register(index: number) {
    const row = rows[index];
    setSummary(null);
    setFieldError({});

    if (row.title.trim() === '') {
      setFieldError({ [index]: '宿題名を入力してください' });
      return;
    }
    if (row.dueDate === '') {
      setFieldError({ [index]: '期限を入力してください' });
      return;
    }

    setPendingIndex(index);
    try {
      await api.post(`/api/cases/${caseId}/tasks`, {
        title: row.title.trim(),
        description: row.description.trim() === '' ? null : row.description.trim(),
        // 起票案からは提出形式まで決められない。既定のテキスト提出で作り、
        // 必要なら K02 で直す（案の粒度を超えた推測をさせない）。
        submissionFormat: 'text',
        allowedFileTypes: [],
        options: {},
        importance: 'normal',
        isRequired: true,
        dueDate: row.dueDate,
      });
      update(index, { registered: true });
      router.refresh();
    } catch (cause) {
      if (cause instanceof ApiCallError) {
        setSummary(cause.message);
        setFieldError({ [index]: Object.values(cause.fieldErrors)[0] ?? '' });
      } else {
        setSummary('通信に失敗しました。時間をおいてお試しください');
      }
    } finally {
      setPendingIndex(null);
    }
  }

  async function finish(decision: 'confirmed' | 'discarded') {
    if (!job) return;
    try {
      await api.patch(`/api/ai/jobs/${job.id}`, { decision });
      setJob({ ...job, status: decision });
    } catch {
      // 記録に失敗しても、登録済みの宿題には影響しない
    }
  }

  return (
    <section className="card">
      <AiHeading note="打ち合わせメモから起こした案です。登録するかどうかはプランナーが決めてください。">
        AIによる起票案（要確認）
      </AiHeading>

      {!aiAvailable && !job && (
        <AiUnavailable
          lastSeenAt={lastSeenAt}
          fallback="起票案は出せませんが、宿題は案件詳細（K02）から手で追加できます。"
        />
      )}

      {!job && aiAvailable && (
        <p className="text-label text-text-muted">
          打ち合わせ記録を保存すると、AIが宿題の案を作ります。
        </p>
      )}

      {job && (
        <AiJobState
          status={job.status}
          errorMessage={job.error_message}
          fallback="宿題は案件詳細（K02）から手で追加できます。"
        />
      )}

      {timedOut && (job?.status === 'queued' || job?.status === 'processing') && (
        <p className="text-caption text-text-muted">
          時間がかかっています。画面を開き直すと最新の状態が表示されます。
        </p>
      )}

      <ErrorSummary message={summary} />

      {(job?.status === 'done' || job?.status === 'confirmed') && (
        rows.length === 0 ? (
          <p className="text-label text-text-primary">
            宿題にあたる内容は見つかりませんでした。
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row, index) => (
              <li key={index} className="rounded-card border border-border-light px-3 py-3">
                <label className="field-label" htmlFor={`proposal-title-${index}`}>宿題名</label>
                <input
                  id={`proposal-title-${index}`}
                  className="field"
                  value={row.title}
                  maxLength={INPUT_LIMITS.shortText}
                  disabled={row.registered}
                  onChange={(e) => update(index, { title: e.target.value })}
                />

                <label className="field-label mt-2" htmlFor={`proposal-desc-${index}`}>説明</label>
                <textarea
                  id={`proposal-desc-${index}`}
                  className="field"
                  rows={2}
                  maxLength={INPUT_LIMITS.templateDescription}
                  disabled={row.registered}
                  value={row.description}
                  onChange={(e) => update(index, { description: e.target.value })}
                />

                <label className="field-label mt-2" htmlFor={`proposal-due-${index}`}>
                  期限{row.dueHint && `（AIの目安: ${row.dueHint}）`}
                </label>
                <input
                  id={`proposal-due-${index}`}
                  type="date"
                  className="field"
                  disabled={row.registered}
                  value={row.dueDate}
                  onChange={(e) => update(index, { dueDate: e.target.value })}
                />

                <FieldError message={fieldError[index]} />

                <div className="mt-3">
                  {row.registered ? (
                    <p className="text-label text-success-text">宿題として登録しました。</p>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary w-auto px-5"
                      disabled={pendingIndex === index}
                      onClick={() => register(index)}
                    >
                      {pendingIndex === index ? '登録中…' : 'この案を宿題として登録する'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      {job?.status === 'done' && (
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-secondary w-auto px-5"
            onClick={() => finish('confirmed')}
          >
            確認を終える
          </button>
          <button
            type="button"
            className="btn-secondary w-auto px-5"
            onClick={() => finish('discarded')}
          >
            この案を破棄する
          </button>
        </div>
      )}
    </section>
  );
}
