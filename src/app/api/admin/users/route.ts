/**
 * /api/admin/users — 利用者の一覧取得（U01）と登録（U02）。
 *
 * 正本: 基本設計書 Version 1.2 表6-5／6-3-5 表6-4／4-3 表4-19／6-3-1。
 *
 * 【Service Role をどこで使うか】
 * 表6-4 の「/api/admin/users（Auth Admin API 利用）」に該当するのは
 * 他人の Auth ユーザーを作る generateLink だけ。user_profiles への書き込みは
 * RLS（user_profiles_admin_write）が権限昇格を塞げるため、通常のセッションで行う。
 * こうしておけば「admin が別式場に planner を作る」「admin が admin を作る」は
 * API 層のバグがあっても DB 層で落ちる（6-3-5 の最終防衛線）。
 *
 * 【利用者種別・所属式場を画面から受け取らない理由】
 * 表4-19 のとおり自動設定であり、任意指定を受け付けると権限昇格の入口になる。
 * role は admin→planner／system_admin→admin に固定し、venue_id は呼び出し元に固定する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { resolvePage } from '@/lib/pagination';
import { userCreateSchema } from '@/lib/validation';
export const GET = route(async (request) => {
  const actor = await requireRole('admin', 'system_admin');
  const params = new URL(request.url).searchParams;
  const pages = params.getAll('page');
  const page = resolvePage(pages.length > 1 ? pages : pages[0]);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const result = await (
      await import('@/lib/d1/staff')
    ).listStaff(await localDB(), actor, { keyword: params.get('q'), page });
    return ok({ users: result.rows, hasNext: result.hasNext, scope: actor.role });
  }
});
export const POST = route(async (request) => {
  const actor = await requireRole('admin', 'system_admin');
  const input = await parseBody(request, userCreateSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    return ok(
      await (await import('@/lib/d1/staff')).createStaff(await localDB(), actor, input),
      201,
    );
  }
});
