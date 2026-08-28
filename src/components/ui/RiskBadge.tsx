/**
 * リスクレベルのバッジと根拠の表示（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 表6-9「DB値とUI表示名の対応」／6-8。
 *
 * 表6-9 は caution の UI 表示を「注意 ／ 要確認」と2通り持ち、
 * 「『7日以上未返信』は『注意』、『提出済だが不備あり』は『要確認』。
 *  内部は caution で統一し reasons で表示切替」と定めている。
 * その切替をここ1箇所に閉じ込める（画面ごとに条件を書くと必ずずれる）。
 *
 * リスクは planner／admin 向けの情報であり、couple 画面では使わない（6-3-2／5-1）。
 */
import { RISK_LEVEL_LABEL, type RiskLevel } from '@/lib/constants';

export interface RiskReasonView {
  conditionKey: string;
  name: string;
  description: string | null;
}

const TONE: Record<RiskLevel, string> = {
  high: 'badge-danger',
  caution: 'badge-warning',
  low: 'badge-neutral',
};

/** caution のうち「不備あり」由来のものは「要確認」と出す（表6-9）。 */
function labelFor(level: RiskLevel, reasons: readonly RiskReasonView[]): string {
  if (level === 'caution' && reasons.some((r) => r.conditionKey === 'needs_fix_exists')) {
    return '要確認';
  }
  return RISK_LEVEL_LABEL[level];
}

export function RiskBadge({
  level,
  reasons = [],
}: {
  level: RiskLevel;
  reasons?: readonly RiskReasonView[];
}) {
  return <span className={TONE[level]}>{labelFor(level, reasons)}</span>;
}

/**
 * スコアと根拠をセットで出す。
 *
 * 1-4「最終判断はプランナーが行う。システムは判断を代替しない」に対応するため、
 * 根拠のない数値だけを表示しない。8-5 の説明可能性も同じ理由。
 */
export function RiskSummary({
  level,
  scoreValue,
  reasons,
}: {
  level: RiskLevel;
  scoreValue: number;
  reasons: readonly RiskReasonView[];
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <RiskBadge level={level} reasons={reasons} />
        <span className="text-caption text-text-muted">スコア {scoreValue}</span>
      </div>
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {reasons.map((reason) => (
            <li key={reason.conditionKey} className="text-caption text-text-secondary">
              ・{reason.description ?? reason.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** まだ一度も算出されていない案件の表示。空欄にすると「低い」と読まれる。 */
export function RiskNotCalculated() {
  return <span className="text-caption text-text-muted">未算出</span>;
}
