/**
 * POST /api/auth/password-reset — パスワード再設定メールの送信（P03 ステップ1）。
 *
 * 正本: 基本設計書 Version 1.2 表6-6（未ログイン許可・レート制限）／4-3 P03／6-3-1。
 *
 * 対象はパスワードを持つ planner／admin／system_admin のみ。
 * couple はパスワードを設定しないため、そもそも対象外である（13-1）。
 */
import { noContent, parseBody, route } from '@/lib/api/route';
import { clientIp, localD1 } from '@/lib/d1/mode';
import { passwordResetRequestSchema } from '@/lib/validation';
export const POST = route(async (request) => {
  const body = await parseBody(request, passwordResetRequestSchema);
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const db = await localDB();
    await (
      await import('@/lib/d1/auth-limits')
    ).authLimit(
      db,
      'password_reset',
      body.email,
      localD1() ? undefined : clientIp(request.headers),
    );
    if (await (await import('@/lib/d1/staff')).passwordResettable(db, body.email)) {
      const auth = await (await import('@/lib/d1/auth')).d1Auth();
      await auth.api.requestPasswordReset({ body: { email: body.email.trim().toLowerCase() } });
    }
    return noContent();
  }
});
