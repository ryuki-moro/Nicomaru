/**
 * /api/auth/** の Route Handler が共有する処理。
 *
 * 正本: 基本設計書 Version 1.2 6-3-1「認証方式」／5-3 auth_rate_limits／表6-6。
 * 「ログイン・ワンタイム認証・パスワード再設定・初回登録の各エンドポイントに
 *  レート制限を設ける」（4-3 P01）を4本のハンドラで同一に守るため、判定をここに集約する。
 *
 * 本ファイルは route.ts ではないためルートにはならない（app/ 配下の通常モジュール）。
 */
import { RATE_LIMITS } from '@/lib/constants';
import { hmacHash, normalizeEmail } from '@/lib/crypto';
import { fromPostgresError, rateLimited } from '@/lib/errors';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export type AuthRateLimitKey = keyof typeof RATE_LIMITS;

/**
 * 招待URL・再設定リンクの着地先を組み立てる。
 * APP_BASE_URL が未設定の開発環境ではリクエスト元のオリジンにフォールバックする（12-1）。
 */
export function appBaseUrl(request: Request): string {
  const configured = process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

/**
 * レート制限キー。「送信元IP＋対象メールアドレス」の HMAC とし、平文は保存しない（表5-19）。
 * IPだけだと同一回線の家族・社内NATを巻き込み、メールだけだと総当たりの発信元を絞れないため
 * 両方を材料にする。
 */
function rateLimitKey(request: Request, email: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
  return hmacHash(`${ip}|${normalizeEmail(email)}`);
}

/**
 * check_rate_limit RPC で原子的に判定する。
 *
 * サーバーレス実行はインスタンスをまたぐためインメモリのカウンタは機能しない（5-3）。
 * auth_rate_limits は authenticated から直接参照させないので、
 * 判定関数の呼び出しにのみ Service Role を用いる（6-3-5 表6-4 'auth.rate-limit' 行）。
 *
 * 上限超過は 429 RATE_LIMITED（6-5-1）。
 */
export async function enforceAuthRateLimit(
  request: Request,
  keyType: AuthRateLimitKey,
  email: string,
): Promise<void> {
  const limit = RATE_LIMITS[keyType];
  const admin = createSupabaseAdminClient('auth.rate-limit');

  const { data, error } = await admin.rpc('check_rate_limit', {
    p_key_type: keyType,
    p_key_hash: rateLimitKey(request, email),
    p_window_seconds: limit.windowSeconds,
    p_max_attempts: limit.max,
  });

  if (error) throw fromPostgresError(error);
  // 戻り値 false = 上限超過。null（想定外）は通してしまわず超過として扱う。
  if (data !== true) throw rateLimited();
}
