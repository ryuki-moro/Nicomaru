/**
 * D02 の 9-11 翻訳補助（Phase 3拡張、Issue #118）。
 *
 * 正本: 基本設計書 7-5。出力は必ずプランナーの確認を経て利用する（7-1）。
 * 採用してもコメント欄へ入れるだけで、送信はしない（DraftAssist と同じ原則）。
 *
 * LLM ワーカーが居ない環境では、定型表現の辞書フォールバック
 * （src/lib/ai/translation-fallback.ts）でその場で訳を出し、デモでも導線を見せられるようにする。
 * 辞書で訳せなかった文は原文のまま残り、cautions で明示される。
 */
'use client';

import { useState } from 'react';

import { AiHeading, AiJobState, AiUnavailable } from '@/components/ai/AiNotice';
import { useAiJob } from '@/components/ai/useAiJob';
import { FieldError } from '@/components/ui/ErrorSummary';
import { adoptedOutput } from '@/lib/ai/assist';
import { ApiCallError, api } from '@/lib/api/client';
import {
  TRANSLATION_TARGETS,
  translateWithDictionary,
  type DictionaryTranslation,
} from '@/lib/ai/translation-fallback';
import { INPUT_LIMITS } from '@/lib/constants';

interface Props {
  caseId: string;
  taskId: string;
  /** 翻訳元の初期値（提出の自由記述など）。空ならコメント欄の内容を使う導線を案内する */
  sourceText: string;
  aiAvailable: boolean;
  lastSeenAt: string | null;
  onAdopt: (text: string) => void;
}

export function TranslationPanel({
  caseId,
  taskId,
  sourceText,
  aiAvailable,
  lastSeenAt,
  onAdopt,
}: Props) {
  const { job, track, setJob, timedOut } = useAiJob(null);
  const [target, setTarget] = useState<'en' | 'ja'>('en');
  const [text, setText] = useState(sourceText);
  const [dict, setDict] = useState<DictionaryTranslation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setError(null);
    setDict(null);
    setPending(true);
    try {
      const created = await api.post<{ id: string }>('/api/ai/jobs', {
        caseId,
        jobType: 'translation',
        relatedTaskId: taskId,
        input: { text: text.trim(), params: { language: target } },
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

  function runDictionary() {
    setError(null);
    setDict(translateWithDictionary(text, target));
  }

  async function adopt(value: string) {
    if (job?.status === 'done') {
      await api.patch(`/api/ai/jobs/${job.id}`, { decision: 'confirmed' }).catch(() => undefined);
      setJob({ ...job, status: 'confirmed' });
    }
    onAdopt(value.slice(0, INPUT_LIMITS.textArea));
  }

  const output = adoptedOutput('translation', job);
  const shown = output ?? dict?.output ?? null;

  return (
    <div className="mb-4 rounded-card border border-border-light bg-bg px-3 py-3">
      <AiHeading note="AIが翻訳した文面です。コメント欄に入れたあと、必ずご自身で確認・修正してください。自動送信はしません。">
        AIによる翻訳（要確認）
      </AiHeading>

      {!aiAvailable && !shown && (
        <AiUnavailable
          lastSeenAt={lastSeenAt}
          fallback="AI翻訳は使えませんが、下の「辞書で翻訳する」で定型表現だけはその場で訳せます。コメントは手入力でも登録できます。"
        />
      )}
      {job && (
        <AiJobState
          status={job.status}
          errorMessage={job.error_message}
          fallback="翻訳が失敗しても、辞書翻訳と手入力は使えます。"
        />
      )}
      {timedOut && (job?.status === 'queued' || job?.status === 'processing') && (
        <p className="text-caption text-text-muted">
          時間がかかっています。辞書翻訳で先に進めることもできます。
        </p>
      )}

      <label className="field-label" htmlFor="translation-source">
        翻訳する文面
      </label>
      <textarea
        id="translation-source"
        className="field"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="翻訳したい文面を入力してください（提出の自由記述が初期値に入ります）"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-caption text-text-muted" htmlFor="translation-target">
          翻訳先
        </label>
        <select
          id="translation-target"
          className="field w-auto"
          value={target}
          onChange={(e) => setTarget(e.target.value as 'en' | 'ja')}
        >
          {TRANSLATION_TARGETS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {shown && (
        <div className="mt-3">
          <p className="whitespace-pre-wrap rounded-field border border-border-light bg-surface px-3 py-2 text-label text-text-primary">
            {shown.text}
          </p>
          {dict && !output && (
            <p className="mt-1 text-caption text-text-muted">
              辞書で訳せた文: {dict.matched} / {dict.total} 文
            </p>
          )}
          {shown.cautions.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-caption text-text-muted">
              {shown.cautions.map((c, i) => (
                <li key={i}>{c}</li>
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
            disabled={pending || text.trim() === ''}
            onClick={request}
          >
            {pending ? '依頼中…' : 'AIに翻訳を頼む'}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary sm:w-56"
          disabled={text.trim() === ''}
          onClick={runDictionary}
        >
          辞書で翻訳する（AI不要）
        </button>
        {shown && (
          <button
            type="button"
            className="btn-secondary sm:w-48"
            disabled={pending}
            onClick={() => adopt(shown.text)}
          >
            コメント欄に入れる
          </button>
        )}
      </div>
    </div>
  );
}
