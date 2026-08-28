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
 */
import type { ReactNode } from 'react';

import type { AiJobStatus } from '@/lib/ai/assist';
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
 * 「使えない」だけでなく「手でやれば済む」ことまで書く。
 * AI が落ちていても業務が止まらないことが 7-1 の趣旨のため。
 */
export function AiUnavailable({ lastSeenAt, fallback }: { lastSeenAt: string | null; fallback: string }) {
  return (
    <div className="banner-info">
      <div>
        <p>ただいまAI補助を利用できません。{fallback}</p>
        {lastSeenAt && (
          <p className="mt-1 text-caption">
            最後にAIサーバーの応答を確認したのは {formatDateTime(lastSeenAt)} です。
          </p>
        )}
      </div>
    </div>
  );
}

/** 生成待ち・失敗の共通表示。done／confirmed のときは呼び出し側が中身を描く。 */
export function AiJobState({
  status,
  errorMessage,
  fallback,
}: {
  status: AiJobStatus;
  errorMessage: string | null;
  fallback: string;
}) {
  if (status === 'queued' || status === 'processing') {
    return (
      <p className="text-label text-text-muted">
        AIに依頼しています。数分後にこの画面を開き直すと結果が表示されます。
      </p>
    );
  }
  if (status === 'failed') {
    return (
      <div className="banner-info">
        <div>
          <p>AIの処理に失敗しました。{fallback}</p>
          {errorMessage && <p className="mt-1 text-caption">理由: {errorMessage}</p>}
        </div>
      </div>
    );
  }
  return null;
}
