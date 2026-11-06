'use client';

/**
 * 席次の確認（#182）。プランナーが提出された席次を見て、承認して確定するか、
 * コメント付きで修正をお願いする。結果はアプリ内通知で新郎新婦へ届く。
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { HallMap } from '@/components/seating/HallMap';
import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import type { SeatingChart, SeatingLayout } from '@/lib/d1/seating';
import type { SeatGuestInfo } from '@/lib/seating/guests';

interface Props {
  caseId: string;
  chart: SeatingChart;
  /** 席次が選んだ配置パターン。未選択・削除済みは null */
  layout: SeatingLayout | null;
  info: Record<string, SeatGuestInfo>;
  /** アーカイブ済みの案件では false（閲覧のみ） */
  editable: boolean;
}

const STATUS_BADGE: Record<SeatingChart['status'], { label: string; cls: string }> = {
  draft: { label: '作成中（未提出）', cls: 'badge-neutral' },
  submitted: { label: '提出済み（確認待ち）', cls: 'badge-warning' },
  approved: { label: '確定済み', cls: 'badge-success' },
  returned: { label: '修正のお願い済み', cls: 'badge-danger' },
};

export function SeatingChartReview({ caseId, chart, layout, info, editable }: Props) {
  const router = useRouter();
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const badge = STATUS_BADGE[chart.status];
  const canReview = editable && chart.status === 'submitted';

  const review = async (decision: 'approved' | 'returned') => {
    if (decision === 'returned' && !feedback.trim()) {
      setError('修正のお願いには、直してほしい内容を入力してください');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/cases/${caseId}/seating-chart/review`, {
        decision,
        feedback: feedback.trim() ? feedback.trim() : null,
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiCallError ? cause.message : '確認を保存できませんでした。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        {chart.submittedAt && (
          <span className="text-caption text-text-secondary">
            提出: {new Date(chart.submittedAt).toLocaleString('ja-JP')}
          </span>
        )}
      </div>

      {chart.status === 'returned' && chart.feedback && (
        <div role="status" className="banner-error">
          <span>修正のお願い: {chart.feedback}</span>
        </div>
      )}
      {chart.status === 'approved' && chart.feedback && (
        <p className="text-caption text-text-secondary">プランナーからの連絡: {chart.feedback}</p>
      )}

      {!layout ? (
        <p className="text-caption text-text-secondary">
          {chart.layoutId
            ? '選ばれた配置パターンは削除されています。'
            : '配置パターンがまだ選ばれていません。'}
        </p>
      ) : (
        <>
          <HallMap
            hall={layout.hallShape}
            tables={layout.tables.map((t) => ({ ...t, key: t.id }))}
            selectedKey={null}
            editable={false}
            onSelect={() => {}}
            renderBody={(t) => (
              <>
                <span className="line-clamp-2 max-w-full break-all text-[11px] font-bold">
                  {t.name}
                </span>
                <span className="text-[10px]">
                  {(chart.seating[t.id] ?? []).length}/{t.capacity}名
                </span>
              </>
            )}
          />
          <ul className="flex flex-col gap-1">
            {layout.tables.map((t) => (
              <li key={t.id} className="text-caption">
                <strong>{t.name}</strong>:{' '}
                {(chart.seating[t.id] ?? [])
                  .map((id) => info[id]?.name ?? '（確認済みでなくなった方）')
                  .join('、') || '（なし）'}
              </li>
            ))}
          </ul>
        </>
      )}

      {canReview && (
        <div className="flex flex-col gap-2">
          <ErrorSummary message={error} />
          <label className="field-label" htmlFor="seating-review-feedback">
            新郎新婦への連絡（差し戻すときは必須）
          </label>
          <textarea
            id="seating-review-feedback"
            className="field"
            rows={3}
            maxLength={1000}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="例: 主賓の席を高砂に近い卓へ移してください"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary w-auto px-5"
              disabled={pending}
              onClick={() => review('approved')}
            >
              承認して確定
            </button>
            <button
              type="button"
              className="btn-secondary w-auto px-5"
              disabled={pending}
              onClick={() => review('returned')}
            >
              修正をお願いする
            </button>
          </div>
        </div>
      )}
      {!canReview && error && <ErrorSummary message={error} />}
    </div>
  );
}
