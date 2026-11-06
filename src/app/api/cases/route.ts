/**
 * GET  /api/cases … 案件一覧の取得（K01 と同じ絞り込み条件をAPIとしても提供する）
 * POST /api/cases … 案件登録（K03）
 *
 * 正本: 基本設計書 Version 1.2 3-3-2「2-1 案件登録」／5-7／6-5 表6-6／6-6-1／6-6-2。
 *
 * 案件登録は wedding_cases・couple_profiles×2・case_invitations×2・communication_logs へ
 * 書き込むため、6-6-2 の「途中失敗時は全体をロールバックする」を満たす必要がある。
 * 一連の書き込みは security definer 関数 create_wedding_case()（20260828000800）へ集約し、
 * ここからは RPC を1回だけ呼ぶ。case_code の採番と UNIQUE 違反時の再試行（5-7）も関数内で行う。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole, requireStaff } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import type { listCases } from '@/lib/d1/cases';
import { forbidden } from '@/lib/errors';
import { caseCreateSchema } from '@/lib/validation';
export const GET = route(async (request: Request) => {
  const started = performance.now();
  const user = await requireStaff();
  const authenticated = performance.now();
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Number(params.get('limit')) || LIST_PAGE_SIZE, LIST_PAGE_SIZE);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);
  // 一覧の組み立ては K01 画面と同じサービス層を使う。
  // 以前はここに別の実装があり、q（キーワード）を無視してリスクも返していなかった（#18）。
  const load = async (options: Parameters<typeof listCases>[2]) => {
    const { localDB } = await import('@/lib/d1/runtime');
    return (await import('@/lib/d1/cases')).listCases(await localDB(), user, options);
  };
  const result = await load({
    scope: params.get('scope') === 'archived' ? 'archived' : 'active',
    sort: params.get('sort') === 'risk' ? 'risk' : 'wedding_date',
    keyword: params.get('q'),
    offset,
    limit,
  });
  const loaded = performance.now();
  const response = ok({
    cases: result.items.map((row) => ({
      id: row.id,
      caseCode: row.caseCode,
      weddingDate: row.weddingDate,
      status: row.status,
      planTypeName: row.planTypeName,
      partners: row.partners,
      taskTotal: row.total,
      taskDone: row.done,
      risk: row.risk,
    })),
    hasNext: result.hasNext,
  });
  // 固定名と所要時間のみ。URL/検索条件/利用者情報をレスポンス計測へ混ぜない。
  response.headers.set(
    'Server-Timing',
    `auth;dur=${(authenticated - started).toFixed(2)},cases;dur=${(loaded - authenticated).toFixed(2)}`,
  );
  return response;
});
export const POST = route(async (request: Request) => {
  // K03 は planner の画面だが、API は planner／admin を許可する（6-5 表6-6）
  const actor = await requireRole('planner', 'admin');
  if (!actor.venueId) throw forbidden('式場に所属していない利用者は案件を登録できません');
  {
    const input = await parseBody(request, caseCreateSchema.strict());
    const { localDB } = await import('@/lib/d1/runtime');
    return ok(
      await (await import('@/lib/d1/onboarding')).createCase(await localDB(), actor, input),
      201,
    );
  }
});
