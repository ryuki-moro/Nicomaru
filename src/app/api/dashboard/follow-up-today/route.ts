/**
 * GET /api/dashboard/follow-up-today — 今日フォローすべきカップル一覧（機能4-2、表6-6、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 D01／6-8。
 *
 * D01 は「リスク高い順、スコア根拠＝未提出宿題・期限超過・最終アクティビティ経過日数を併記」
 * と定めている。根拠を必ず一緒に返すのは、8-5「保守性・説明可能性」と
 * 1-4「最終判断はプランナーが行う。システムは判断を代替しない」に対応するため。
 * スコアだけ見せると、プランナーが理由を確認せずに従う運用になりやすい。
 *
 * 値は risk_score_snapshots の現在値を読むだけで、ここでは再計算しない
 * （6-8「一覧表示時に毎回全件再計算せず、更新時・定期処理・明示再計算で保存する」）。
 */
import { ok, route } from '@/lib/api/route';
import { requireStaff } from '@/lib/auth/session';
import { COUPLE_PROFILE_COLUMNS, RISK_LEVEL_RANK, type RiskLevel } from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { fromPostgresError } from '@/lib/errors';
import type { RiskReason } from '@/lib/services/risk';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/** D01 に出す件数。全件出すと「今日見るべき」という画面の意図が薄れる。 */
const LIMIT = 20;

interface SnapshotRow {
  case_id: string;
  score_value: number;
  score_level: RiskLevel;
  reasons: RiskReason[] | null;
  calculated_at: string;
  wedding_cases: {
    id: string;
    case_code: string;
    wedding_date: string;
    primary_planner_id: string;
  } | null;
}

export const GET = route(async () => {
  const user = await requireStaff();
  const supabase = await createSupabaseServerClient();

  // RLS（risk_score_snapshots_select）が案件スコープとロールを担保する。
  // planner は自担当のみ、admin は自式場内が見える。
  const { data, error } = await supabase
    .from('risk_score_snapshots')
    .select(
      `case_id, score_value, score_level, reasons, calculated_at,
       wedding_cases!inner ( id, case_code, wedding_date, primary_planner_id )`,
    )
    .eq('is_current', true)
    .neq('score_level', 'low');
  if (error) throw fromPostgresError(error);

  const rows = (data ?? []) as unknown as SnapshotRow[];
  const caseIds = rows.map((r) => r.case_id);

  // カップル名は別で引く。埋め込みで取ると memo を含む select になり 42501 で落ちる（付録A）。
  const nameByCase = new Map<string, string[]>();
  if (caseIds.length > 0) {
    const profiles = await supabase
      .from('couple_profiles')
      .select(COUPLE_PROFILE_COLUMNS)
      .in('case_id', caseIds);
    if (profiles.error) throw fromPostgresError(profiles.error);
    for (const p of (profiles.data ?? []) as unknown as
      { case_id: string; full_name: string; is_primary_contact: boolean }[]) {
      const list = nameByCase.get(p.case_id) ?? [];
      // 主連絡先を先頭に出す（K01 の表示順と揃える）
      if (p.is_primary_contact) list.unshift(readPii(p.full_name));
      else list.push(readPii(p.full_name));
      nameByCase.set(p.case_id, list);
    }
  }

  const items = rows
    .map((row) => ({
      caseId: row.case_id,
      caseCode: row.wedding_cases?.case_code ?? '',
      weddingDate: row.wedding_cases?.wedding_date?.slice(0, 10) ?? null,
      coupleName: (nameByCase.get(row.case_id) ?? []).filter(Boolean).join('・'),
      scoreValue: row.score_value,
      scoreLevel: row.score_level,
      // 根拠はスコアと必ずセットで返す（1-4／8-5）
      reasons: (row.reasons ?? []).map((r) => ({
        conditionKey: r.conditionKey,
        name: r.name,
        description: r.description,
      })),
      calculatedAt: row.calculated_at,
      isMine: row.wedding_cases?.primary_planner_id === user.id,
    }))
    // リスクの高い順 → スコアの大きい順 → 挙式日が近い順。同着は case_id で決定的にする。
    .sort((a, b) =>
      RISK_LEVEL_RANK[b.scoreLevel] - RISK_LEVEL_RANK[a.scoreLevel]
      || b.scoreValue - a.scoreValue
      || (a.weddingDate ?? '9999-12-31').localeCompare(b.weddingDate ?? '9999-12-31')
      || a.caseId.localeCompare(b.caseId))
    .slice(0, LIMIT);

  return ok({ items });
});
