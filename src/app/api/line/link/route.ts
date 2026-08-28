/**
 * POST /api/line/link — LINE 連携用の nonce 発行（機能1-3、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-10 手順(3)「ログイン済みセッションで nonce を突合」。
 *
 * M06 から呼ぶ。ログイン中の利用者に一度限りの nonce を発行し、
 * LINE のアカウント連携ダイアログへ渡すURLを返す。
 * 「直近の招待や登録者に当てる」ような推測による紐付けは行わない（6-10）ため、
 * **誰と結び付けるかはこのセッションでしか決めない**。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { fromPostgresError } from '@/lib/errors';
import {
  LINE_NONCE_TTL_SECONDS,
  accountLinkUrl,
  generateLinkNonce,
  hashLinkNonce,
} from '@/lib/notify/line';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { lineLinkSchema } from '@/lib/validation';

export const runtime = 'nodejs';

export const POST = route(async (request: Request) => {
  // 連携するのは新郎新婦のアカウント（機能1-3／M06）
  const user = await requireRole('couple');
  const input = await parseBody(request, lineLinkSchema);

  const nonce = generateLinkNonce();

  // line_link_nonces は authenticated に開いていない（他人の nonce を狙う足がかりになる）。
  // 発行はサーバー側で行う。
  const admin = createSupabaseAdminClient('cron.notifications-dispatch');
  const { error } = await admin.from('line_link_nonces').insert({
    nonce_hash: hashLinkNonce(nonce),
    user_profile_id: user.id,
    link_token: input.linkToken,
    expires_at: new Date(Date.now() + LINE_NONCE_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) throw fromPostgresError(error);

  // 平文の nonce はこの応答でしか返さない（招待トークンと同じ扱い。6-3-6）
  return ok({ url: accountLinkUrl(input.linkToken, nonce) }, 201);
});
