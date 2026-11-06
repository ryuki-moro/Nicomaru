/**
 * POST /api/cases/{caseId}/risk/recalculate — 指定案件のリスク再計算（表6-6、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-8「業務ロジック：リスク算出」／3-3-5。
 *
 * 6-8 は「一覧表示時に毎回全件再計算せず、更新時・定期処理・明示再計算で保存する」と定めている。
 * 本ルートはそのうち「明示再計算」（プランナーが画面から叩く）を担う。
 * 日次の定期処理は /api/internal/risk-recalculate が venue_id → case_id でループする（6-12）。
 */
import { ok, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { isUuid } from '@/lib/uuid';
export const runtime = 'nodejs';
export const POST = route(
  async (
    _request: Request,
    context: {
      params: Promise<{
        caseId: string;
      }>;
    },
  ) => {
    // リスクは planner／admin 向けの情報。couple には値そのものを見せない（6-3-2／5-1）。
    await requireStaff();
    const { caseId } = await context.params;
    if (!isUuid(caseId)) {
      // 形式が違う時点で案件は存在しない。RLS の判定へ渡す前に落とす。
      return ok({ error: null }, 404);
    }
    {
      const { localDB } = await import('@/lib/d1/runtime');
      const { recalculateCaseRiskD1 } = await import('@/lib/d1/risk');
      const { caseRow } = await import('@/lib/d1/cases');
      const user = await requireStaff();
      const db = await localDB();
      // スコープ判定は D1 の caseRow (scope 述語) で行い、見えない案件は 404 に倒す。
      await caseRow(db, user, caseId);
      const result = await recalculateCaseRiskD1(db, caseId);
      return ok({
        caseId,
        scoreValue: result.scoreValue,
        scoreLevel: result.scoreLevel,
        reasons: result.reasons,
      });
    }
  },
);
