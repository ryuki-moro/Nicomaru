import type { D1Database } from '@cloudflare/workers-types';
import type { AppUser } from '@/lib/auth/session';
import type { RiskLevel } from '@/lib/constants';
import { RISK_LEVEL_RANK } from '@/lib/constants';
import type { RiskReasonView } from '@/components/ui/RiskBadge';
import { readPii } from '@/lib/crypto';
import { forbidden } from '@/lib/errors';
import { scope } from './cases';

export async function dashboard(db: D1Database, user: AppUser) {
  if (user.role === 'couple') throw forbidden();
  const rows = await db
    .prepare(
      `SELECT c.id,c.case_code,c.wedding_date,c.primary_planner_id,
    (SELECT count(*) FROM case_tasks t WHERE t.case_id=c.id AND t.status IN ('not_started','needs_fix')) AS unsubmitted,
    (SELECT count(*) FROM task_submissions s JOIN case_tasks t ON t.id=s.case_task_id WHERE t.case_id=c.id AND s.review_status='submitted' AND s.is_latest=1 AND t.status<>'waived') AS pending_review,
    (SELECT json_group_array(cp.full_name) FROM (SELECT full_name FROM couple_profiles WHERE case_id=c.id ORDER BY is_primary_contact DESC) cp) AS names,
    r.score_value,r.score_level,r.reasons,r.calculated_at
    FROM wedding_cases c LEFT JOIN risk_score_snapshots r ON r.case_id=c.id AND r.is_current=1
    WHERE c.archived_at IS NULL AND ${scope}`,
    )
    .bind(user.id)
    .all<{
      id: string;
      case_code: string;
      wedding_date: string;
      primary_planner_id: string;
      unsubmitted: number;
      pending_review: number;
      names: string;
      score_value: number | null;
      score_level: RiskLevel | null;
      reasons: string | null;
      calculated_at: string | null;
    }>();
  const followUps = rows.results
    .filter((r) => r.score_level && r.score_level !== 'low')
    .map((r) => ({
      caseId: r.id,
      caseCode: r.case_code,
      weddingDate: r.wedding_date,
      coupleName: (JSON.parse(r.names) as string[]).map(readPii).join('・'),
      scoreValue: r.score_value ?? 0,
      scoreLevel: r.score_level!,
      reasons: JSON.parse(r.reasons ?? '[]') as RiskReasonView[],
      calculatedAt: r.calculated_at,
      isMine: r.primary_planner_id === user.id,
    }))
    .sort(
      (a, b) =>
        RISK_LEVEL_RANK[b.scoreLevel] - RISK_LEVEL_RANK[a.scoreLevel] ||
        b.scoreValue - a.scoreValue ||
        a.weddingDate.localeCompare(b.weddingDate) ||
        a.caseId.localeCompare(b.caseId),
    );
  return {
    caseCount: rows.results.length,
    unsubmittedCount: rows.results.reduce((n, r) => n + r.unsubmitted, 0),
    // D02 の確認待ち一覧（pendingSubmissions）と同じ条件で数える。件数と一覧がずれないようにする
    pendingReviewCount: rows.results.reduce((n, r) => n + r.pending_review, 0),
    highRiskCount: rows.results.filter((r) => r.score_level === 'high').length,
    followUps,
  };
}
