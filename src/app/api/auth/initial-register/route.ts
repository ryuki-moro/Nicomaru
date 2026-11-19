/**
 * POST /api/auth/initial-register — 招待URLからの初回登録（P02 / 機能1-2）。
 *
 * 正本: 基本設計書 Version 1.2 6-6-1「初回登録フロー」／6-3-5 表6-4／13-1。
 *
 * 未ログイン状態で case_invitations を照合する必要があるため Service Role を使う。
 * RLS をバイパスする代わりに、表6-4 が要求する検証をすべて本ハンドラで明示的に行う:
 *   (1) token_hash 照合と expires_at／used_at／revoked_at／purpose／max_uses チェックを
 *       単一の UPDATE ... RETURNING（consume_invitation）で原子的に実施する。
 *   (2) recipient_email が設定された招待は入力メールとの一致を必須とする。
 *       recipient_email が NULL（LINE案内）の招待は、確認コード検証まで案件へ紐付けない。
 *   (3) Auth ユーザー → user_profiles → 既存 couple_profiles への紐付け、の順に確定する。
 *   (4) 途中失敗時は補償処理で巻き戻す。自動リトライはしない。
 *   (5) communication_logs に source='initial_register' で自動記録する。
 */
import { ok, parseBody, route } from '@/lib/api/route';
import { clientIp, localD1 } from '@/lib/d1/mode';
import { initialRegisterSchema } from '@/lib/validation';
/** consume_invitation() の戻り（20260828000700_auth_functions.sql）。 */
interface ConsumedInvitation {
  id: string;
  case_id: string;
  target_partner_role: string;
  recipient_email_hash: string | null;
}
interface CaseRow {
  id: string;
  venue_id: string;
}
interface UserProfileRow {
  id: string;
  auth_user_id: string;
  role: string;
  status: string;
}
interface CoupleProfileRow {
  id: string;
  user_profile_id: string | null;
  email: string | null;
  email_hash: string | null;
}
export const POST = route(async (request) => {
  {
    const body = await parseBody(request, initialRegisterSchema.strict());
    const { localDB } = await import('@/lib/d1/runtime');
    const db = await localDB();
    await (
      await import('@/lib/d1/auth-limits')
    ).authLimit(
      db,
      'initial_register',
      body.email,
      localD1() ? undefined : clientIp(request.headers),
    );
    const session = await (
      await (await import('@/lib/d1/auth')).d1Auth()
    ).api.getSession({ headers: request.headers });
    return ok(
      await (await import('@/lib/d1/onboarding')).registerCouple(db, body, session?.user ?? null),
    );
  }
});
