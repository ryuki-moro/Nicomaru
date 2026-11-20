/**
 * AI補助の共通表示（Phase 3、機能9-1〜9-5）。
 *
 * 正本: 基本設計書 7-1。
 *
 *   「AIが生成した文面・分類であることを画面上に明示する」
 *   「出力は必ずプランナーの確認を経て利用する（自動送信・自動登録は行わない）」
 *   「LLMサーバー停止時は該当機能を『利用不可』と表示し、手動運用にフォールバックする」
 *
 * 明示の文言を各画面が自作すると、7-2 が定めた
 * 「AIによる分類（要確認）」「AIによる一次チェック（要確認）」の表記が画面ごとにぶれる。
 * ここに集約して、AI由来の表示は必ずこの見出しの下に置く。
 *
 * Server Component からも Client Component からも使うため 'use client' は付けない。
 * （折りたたみは <details> で実現し、クライアントJSを要しない）
 */
import type { ReactNode } from 'react';

import type { AiJobStatus } from '@/lib/ai/assist';
import {
  AI_ADOPTED_MESSAGE,
  AI_DISCARDED_MESSAGE,
  AI_PENDING_MESSAGE,
  AI_TIMEOUT_MESSAGE,
  humanAiError,
} from '@/lib/ai/aiMessages';
import { formatDateTime } from '@/lib/format';

/** 7-2 の表記に合わせた見出し。ここに無い文言を画面側で作らない。 */
export const AI_HEADINGS = {
  classification: 'AIによる分類（要確認）',
  defectCheck: 'AIによる一次チェック（要確認）',
  draft: 'AIによる下書き（要確認）',
  taskExtraction: 'AIによる起票案（要確認）',
  sheetDraft: 'AIによる要点の下書き（要確認）',
} as const;

export function AiHeading({
  children,
  note,
}: {
  children: ReactNode;
  /** 見出しの下に置く1行。何を確認してほしいかを画面ごとに書く */
  note?: string;
}) {
  return (
    <div className="mb-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className="badge-warning">{children}</span>
      </p>
      {note && <p className="mt-1 text-caption text-text-muted">{note}</p>}
    </div>
  );
}

/**
 * ワーカー停止時の案内（7-1）。
 *
 * 普段は1行だけを出し、本来の作業（コメント欄など）を押し出さない
 * （docs/ui-review/p2 低-5）。手作業で進められる旨と最終確認時刻は
 * 折りたたみの中に置き、知りたい人だけが開く。
 */
export function AiUnavailable({
  lastSeenAt,
  fallback,
  summary = 'ただいまAI補助を利用できません（詳細）',
  children,
}: {
  lastSeenAt: string | null;
  fallback: string;
  /** 1行目の文言。複数のAI欄をまとめて案内するときに、対象を書き添える */
  summary?: string;
  /** AIが無くても使える代わりの手段（辞書翻訳など）。折りたたみの中に置く */
  children?: ReactNode;
}) {
  return (
    <details className="text-label text-text-secondary">
      <summary className="cursor-pointer py-1 text-text-muted">{summary}</summary>
      <div className="banner-info mt-1">
        <div>
          <p>{fallback}</p>
          {lastSeenAt && (
            <p className="mt-1 text-caption">
              最後にAIサーバーの応答を確認したのは {formatDateTime(lastSeenAt)} です。
            </p>
          )}
        </div>
      </div>
      {children && <div className="mt-2">{children}</div>}
    </details>
  );
}

/** ポーリング打ち切り（タイムアウト）の統一表示。文言は aiMessages を単一ソースにする。 */
export function AiTimeoutNotice() {
  return (
    <p className="mt-2 text-caption text-text-muted" role="status">
      {AI_TIMEOUT_MESSAGE}
    </p>
  );
}

/** 採用済み・破棄済みの墓標。結果を消さず、状態が残ることを利用者に伝える。 */
export function AiOutcomeTombstone({ status }: { status: 'confirmed' | 'discarded' }) {
  if (status === 'confirmed') {
    return (
      <p className="mt-2 flex items-center gap-2 text-label text-text-secondary" role="status">
        <span className="badge-success">採用済み</span>
        {AI_ADOPTED_MESSAGE}
      </p>
    );
  }
  return (
    <p className="mt-2 flex items-center gap-2 text-label text-text-secondary" role="status">
      <span className="badge-neutral">破棄済み</span>
      {AI_DISCARDED_MESSAGE}
    </p>
  );
}

/**
 * 生成待ち・失敗・破棄の共通表示。done／confirmed のときは呼び出し側が中身を描く
 * （confirmed は AiOutcomeTombstone と併用できる）。
 */
export function AiJobState({
  status,
  errorMessage,
  fallback,
  onRetry,
  retryLabel = 'もう一度依頼する',
}: {
  status: AiJobStatus;
  errorMessage: string | null;
  fallback: string;
  /** 失敗時にその場で再依頼できる場合に渡す。再依頼の経路が無い画面では省略する */
  onRetry?: () => void;
  retryLabel?: string;
}) {
  if (status === 'queued' || status === 'processing') {
    return (
      <p
        className="flex items-center gap-2 text-label text-text-muted"
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden="true"
          className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
        {AI_PENDING_MESSAGE}
      </p>
    );
  }
  if (status === 'failed') {
    return (
      <div className="banner-error" role="alert">
        <div>
          <p>
            {humanAiError(errorMessage)} {fallback}
          </p>
          {onRetry && (
            <button type="button" className="btn-ghost mt-2" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (status === 'discarded') {
    return <AiOutcomeTombstone status="discarded" />;
  }
  return null;
}
