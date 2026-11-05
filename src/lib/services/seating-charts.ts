/**
 * 席次（#181）の読み取り。書き込みは DB 関数（save_seating_chart・submit_seating_chart）だけが行う。
 * 参照範囲は RLS が決める。席次の行がまだ無い案件は、下書き・版 0・未配置として返す。
 */
import type { Seating } from '@/lib/seating/assign';
import type { SupabaseServerClient } from '@/lib/supabase/server';

export const SEATING_CHART_STATUSES = ['draft', 'submitted', 'approved', 'returned'] as const;
export type SeatingChartStatus = (typeof SEATING_CHART_STATUSES)[number];

export interface SeatingChart {
  status: SeatingChartStatus;
  version: number;
  layoutId: string | null;
  /** プランナーからのご連絡（修正のお願い） */
  feedback: string | null;
  submittedAt: string | null;
  seating: Seating;
}

/** 案件の席次を読む。読めなかった場合は null。 */
export async function loadSeatingChart(
  supabase: SupabaseServerClient,
  caseId: string,
): Promise<SeatingChart | null> {
  const [chart, assignments] = await Promise.all([
    supabase
      .from('seating_charts')
      .select('status, version, layout_id, feedback, submitted_at')
      .eq('case_id', caseId)
      .maybeSingle(),
    supabase
      .from('seating_assignments')
      .select('guest_id, table_id, seat_order')
      .eq('case_id', caseId)
      .order('table_id', { ascending: true })
      .order('seat_order', { ascending: true }),
  ]);
  if (chart.error || assignments.error) return null;

  const seating: Seating = {};
  for (const row of (assignments.data ?? []) as {
    guest_id: string;
    table_id: string;
    seat_order: number;
  }[]) {
    (seating[row.table_id] ??= []).push(row.guest_id);
  }

  const row = chart.data as {
    status: SeatingChartStatus;
    version: number;
    layout_id: string | null;
    feedback: string | null;
    submitted_at: string | null;
  } | null;
  return {
    status: row?.status ?? 'draft',
    version: row?.version ?? 0,
    layoutId: row?.layout_id ?? null,
    feedback: row?.feedback ?? null,
    submittedAt: row?.submitted_at ?? null,
    seating,
  };
}
