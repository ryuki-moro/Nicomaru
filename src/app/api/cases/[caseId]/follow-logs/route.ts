/**
 * GET/POST /api/cases/{caseId}/follow-logs — フォロー記録の取得・登録（6-5 表6-6、4-3 D04）。
 *
 * 単一テーブルの操作だが 6-5 表6-6 に明記された API のため Route Handler として実装する。
 * planner_id はリクエストから受け取らずログイン中の利用者で確定させる。
 * 実施者を外部から指定できると、他プランナーの実績として記録できてしまうため（6-3-5 と同じ考え方）。
 */
import { requireStaff } from '@/lib/auth/session';
import { ok, parseBody, route } from '@/lib/api/route';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { fromPostgresError, notFound } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { followLogSchema } from '@/lib/validation';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = 'id, case_id, planner_id, method, note, followed_at, created_at';

/** RLS（follow_logs_all）は accessible_case_ids() を条件に持つため、範囲外の案件は 0 行になる。 */
async function requireVisibleCase(caseId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('wedding_cases')
    .select('id')
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw fromPostgresError(error);
  if (!data) throw notFound();
  return supabase;
}

export const GET = route(
  async (_request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const { caseId } = await context.params;
    await requireStaff();
    if (!UUID_PATTERN.test(caseId)) throw notFound();

    const supabase = await requireVisibleCase(caseId);
    const { data, error } = await supabase
      .from('follow_logs')
      .select(SELECT_COLUMNS)
      .eq('case_id', caseId)
      // 直近の記録から見せる。同着は id を最終タイブレークにする（4-3 一覧画面共通）
      .order('followed_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(LIST_PAGE_SIZE);
    if (error) throw fromPostgresError(error);

    return ok({ items: data ?? [] });
  },
);

export const POST = route(
  async (request: Request, context: { params: Promise<{ caseId: string }> }) => {
    const { caseId } = await context.params;
    const user = await requireStaff();
    if (!UUID_PATTERN.test(caseId)) throw notFound();

    const input = await parseBody(request, followLogSchema);
    const supabase = await requireVisibleCase(caseId);

    const { data, error } = await supabase
      .from('follow_logs')
      .insert({
        case_id: caseId,
        planner_id: user.id,
        method: input.method,
        note: input.note ?? null,
        followed_at: input.followedAt,
      })
      .select(SELECT_COLUMNS)
      .single();
    if (error) throw fromPostgresError(error);

    return ok(data, 201);
  },
);
