import { hmacHash, normalizeEmail } from '@/lib/crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { awaitAudit } from './audit-deadline';

/** 認証失敗そのものの応答を維持し、監査障害の詳細やPIIをログに出さない。 */
export async function recordAuthenticationFailure(
  email: string,
  method: 'password' | 'otp',
): Promise<void> {
  try {
    const admin = createSupabaseAdminClient('audit.auth-event');
    await awaitAudit(
      admin.rpc('record_auth_failure', {
        p_account_hash: hmacHash(`auth-failure|${normalizeEmail(email)}`),
        p_method: method,
      }),
    );
  } catch {
    console.warn('[audit] 認証失敗の監査記録を保存できませんでした');
  }
}

export async function recordPasswordResetRequest(): Promise<void> {
  try {
    await awaitAudit(
      createSupabaseAdminClient('audit.auth-event').rpc('record_password_reset_request'),
    );
  } catch {
    console.warn('[audit] パスワード再設定要求の監査記録を保存できませんでした');
  }
}
