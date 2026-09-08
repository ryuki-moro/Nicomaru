/**
 * E2E 用の環境変数（tests/e2e 専用）。
 *
 * Service Role Key は本体の ESLint ルール（6-3-5「Service Role 誤用防止」）で
 * `SUPABASE_SERVICE_ROLE_KEY` の直接参照を禁じているため、E2E のデータ投入には
 * 別名 `E2E_SUPABASE_SERVICE_ROLE_KEY` を使う。値はローカルスタックの鍵と同じでよい。
 */
export const e2eEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  serviceRoleKey: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? '',
  /** ローカル Supabase のメール受信箱（Mailpit）。`supabase status` の MAILPIT_URL／INBUCKET_URL */
  mailUrl: (process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:54324').replace(/\/$/, ''),
};

/** 接続情報が無い環境（通常の `npm test` など）ではスキップする（playwright.config.ts の方針） */
export const hasE2eEnv = Boolean(e2eEnv.supabaseUrl && e2eEnv.anonKey && e2eEnv.serviceRoleKey);

/** seed.sql の式場（BRIDAL01） */
export const VENUE_ID = '11111111-1111-4111-8111-111111111111';

/** プランナーのパスワード規約（12文字以上）を満たす固定値。ローカル専用 */
export const PLANNER_PASSWORD = 'E2e-Planner-Passw0rd!';

/** 実行ごとに衝突しないメールアドレス。`.test` は予約TLDで外部へ届かない */
export function uniqueEmail(prefix: string): string {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}-${stamp}@e2e.test`;
}

/** 今日から days 日後を YYYY-MM-DD（JST）で返す。挙式日は未来日でなければならない */
export function futureDate(days: number): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000 + days * 24 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}
