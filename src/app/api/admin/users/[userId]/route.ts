/**
 * /api/admin/users/{userId} — 利用者の変更（U03）と論理削除（U04）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-20／U04 の記述／6-3-1／6-3-5 表6-4／13-1。
 *
 * 【Service Role の範囲】
 * 表6-4 に沿い、他人の Auth ユーザーに触れる操作（メール同期・停止・無効化・
 * 設定リンクの再発行）だけを Service Role で行う。user_profiles／wedding_cases の
 * 更新は RLS 経由にして、権限の境界を DB 層に残す。
 *
 * 【セッション失効の考え方（13-1）】
 * Auth 側の ban はリフレッシュを止めるが、発行済みアクセストークンは最長1時間残る。
 * 実際の遮断は RLS 共通関数 current_app_user() が status='active' を必須とすることで
 * 即座に効く。したがって ban の失敗は致命傷ではなく、記録して処理を続ける。
 */
import { noContent, ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { type Role, type UserStatus } from '@/lib/constants';
import { unprocessable } from '@/lib/errors';
import { userDeleteSchema, userUpdateWithActionSchema } from '@/lib/validation';
type RouteContext = {
  params: Promise<{
    userId: string;
  }>;
};
interface ManagedUser {
  id: string;
  auth_user_id: string;
  venue_id: string | null;
  role: Role;
  display_name: string;
  email: string;
  phone: string | null;
  status: UserStatus;
}
export const PATCH = route<[RouteContext]>(async (request, context) => {
  const actor = await requireRole('admin', 'system_admin');
  const { userId } = await context.params;
  const input = await parseBody(request, userUpdateWithActionSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    return ok(
      await (await import('@/lib/d1/staff')).updateStaff(await localDB(), actor, userId, input),
    );
  }
});
export const DELETE = route<[RouteContext]>(async (request, context) => {
  const actor = await requireRole('admin', 'system_admin');
  const { userId } = await context.params;
  const input = await parseBody(request, userDeleteSchema);
  // U04:「ログイン中の自身は削除不可」
  if (userId === actor.id) {
    throw unprocessable('ログイン中のご自身のアカウントは削除できません');
  }
  {
    const { localDB } = await import('@/lib/d1/runtime');
    await (
      await import('@/lib/d1/staff')
    ).deleteStaff(await localDB(), actor, userId, input.successorPlannerId);
    return noContent();
  }
});
