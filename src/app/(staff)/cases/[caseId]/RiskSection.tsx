/**
 * K02 リスクスコアと根拠の表示（4-3 K02、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02／6-8／機能6-2。
 *
 *   「リスクスコア（高／注意／低）と根拠は Phase 2 で追加し、
 *     planner／admin のみ表示、couple には非表示」
 *
 * 本コンポーネントは (staff) レイアウト配下でのみ使う。
 * couple 向けの案件詳細（マイページ内）からは呼ばない — 6-3「新郎新婦側には
 * スコアそのものを表示せず、『次にやること』『期限が近い宿題』に変換して表示」に従う。
 *
 * 「再計算する」は 6-8 が挙げる3つの契機のうちの「明示再計算」。
 * 日次の定期処理と提出・確認時のイベントで更新されるので、通常は押す必要がない。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { RiskSummary, type RiskReasonView } from '@/components/ui/RiskBadge';
import { ApiCallError, api } from '@/lib/api/client';
import type { RiskLevel } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';

export interface CaseRisk {
  scoreValue: number;
  scoreLevel: RiskLevel;
  reasons: RiskReasonView[];
  calculatedAt: string;
}

export function RiskSection({ caseId, risk }: { caseId: string; risk: CaseRisk | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recalculate() {
    setError(null);
    setPending(true);
    try {
      await api.post(`/api/cases/${caseId}/risk/recalculate`);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : '再計算できませんでした');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-head">リスク</h2>
        <button
          type="button"
          className="btn-ghost disabled:opacity-50"
          disabled={pending}
          onClick={recalculate}
        >
          {pending ? '再計算中…' : '再計算する'}
        </button>
      </div>

      <ErrorSummary message={error} />

      {risk ? (
        <>
          <RiskSummary
            level={risk.scoreLevel}
            scoreValue={risk.scoreValue}
            reasons={risk.reasons}
          />
          <p className="text-caption text-text-muted">
            {formatDateTime(risk.calculatedAt)} 時点の算出結果です。
            最終的な判断はプランナーが行ってください。
          </p>
        </>
      ) : (
        <p className="text-label text-text-muted">
          まだ算出されていません。「再計算する」を押すか、翌日の自動算出をお待ちください。
        </p>
      )}
    </section>
  );
}
