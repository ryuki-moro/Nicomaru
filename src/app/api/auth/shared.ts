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

/**
 * ワンタイムコードの失効カウンタの鍵（5-3「検証失敗5回で当該コードを失効」）。
 *
 * 送信元IPを混ぜない。混ぜると接続元を変えるだけで別カウンタになり、失効しなくなる。
 * 総当たりの発信元を絞る目的は otp_verify（IP＋メール）が別に担っている。
 */
function otpFailureKey(email: string): string {
  return hmacHash(`otp-failure|${normalizeEmail(email)}`);
}

/** 失効しているか。数を増やさずに見る（検証の前に呼ぶ）。 */
export async function isOtpCodeInvalidated(email: string): Promise<boolean> {
  const limit = RATE_LIMITS.otp_verify_failure;
  const admin = createSupabaseAdminClient('auth.rate-limit');

  const { data, error } = await admin.rpc('peek_rate_limit', {
    p_key_type: 'otp_verify_failure',
    p_key_hash: otpFailureKey(email),
    p_window_seconds: limit.windowSeconds,
    p_max_attempts: limit.max,
  });

  if (error) throw fromPostgresError(error);
  // true = まだ受け付けてよい。想定外（null）は安全側に倒して「失効」と扱う。
  return data !== true;
}

/** 検証に失敗したので1回数える。 */
export async function recordOtpVerifyFailure(email: string): Promise<void> {
  const limit = RATE_LIMITS.otp_verify_failure;
  const admin = createSupabaseAdminClient('auth.rate-limit');

  const { error } = await admin.rpc('check_rate_limit', {
    p_key_type: 'otp_verify_failure',
    p_key_hash: otpFailureKey(email),
    p_window_seconds: limit.windowSeconds,
    p_max_attempts: limit.max,
  });
  // 数えられなかったこと自体でログインを止めない（判定は次回の peek に委ねる）
  if (error) console.warn('[auth] ワンタイムコードの失敗回数を記録できませんでした', error);
}

/** 認証に成功したので失効カウンタを消す。打ち間違えた人を次回まで縛らない。 */
export async function clearOtpVerifyFailures(email: string): Promise<void> {
  const admin = createSupabaseAdminClient('auth.rate-limit');
  const { error } = await admin.rpc('clear_rate_limit', {
    p_key_type: 'otp_verify_failure',
    p_key_hash: otpFailureKey(email),
  });
  if (error) console.warn('[auth] ワンタイムコードの失敗回数を消せませんでした', error);
}
