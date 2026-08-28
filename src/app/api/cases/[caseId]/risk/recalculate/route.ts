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
import { persistViaRpc, recalculateCaseRisk } from '@/lib/services/riskStore';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = route(
  async (_request: Request, context: { params: Promise<{ caseId: string }> }) => {
    // リスクは planner／admin 向けの情報。couple には値そのものを見せない（6-3-2／5-1）。
    await requireStaff();

    const { caseId } = await context.params;
    if (!UUID_RE.test(caseId)) {
      // 形式が違う時点で案件は存在しない。RLS の判定へ渡す前に落とす。
      return ok({ error: null }, 404);
    }

    const supabase = await createSupabaseServerClient();
    // 案件のスコープ判定は RLS と save_risk_snapshot() の両方が行う（多層防御）。
    const result = await recalculateCaseRisk(supabase, caseId, persistViaRpc(supabase, caseId));

    return ok({
      caseId,
      scoreValue: result.scoreValue,
      scoreLevel: result.scoreLevel,
      reasons: result.reasons,
    });
  },
);
