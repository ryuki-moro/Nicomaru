/** d1: Cloudflare Workers上の本番。d1-local: ループバック限定のローカル検証（外部送信なし）。 */
export const usingD1 = () =>
  process.env.NICOMARU_DB === 'd1' || process.env.NICOMARU_DB === 'd1-local';
export const localD1 = () => process.env.NICOMARU_DB === 'd1-local';
/** ローカルD1の待受先。3104 は npm run dev:d1、3105 は npm run demo。 */
export const isLocalD1Origin = (origin: string | undefined) =>
  origin === 'http://127.0.0.1:3104' || origin === 'http://127.0.0.1:3105';
/** 本番D1のデモ用受信箱。外部送信の代わりに保存し、system_admin だけが読む。実利用者を入れる前に外す。 */
export const demoMailbox = () =>
  process.env.NICOMARU_DB === 'd1' && process.env.DEMO_MAILBOX === 'on';
/** 外部送信せず受信箱へ保存する（ローカル検証とデモ受信箱）。 */
export const captureOnly = () => localD1() || demoMailbox();
// クライアントではNEXT_PUBLIC_の値がビルド時に埋め込まれる。
export const publicD1 = () =>
  process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1' ||
  process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1-local';
export const publicLocalD1 = () => process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1-local';
/** npm run demo のログイン素通り。ローカルD1でだけ有効（本番D1・Supabaseでは常に無効）。 */
export const demoLogin = () => localD1() && process.env.NICOMARU_DEMO_LOGIN === 'true';
export const publicDemoLogin = () =>
  publicLocalD1() && process.env.NEXT_PUBLIC_NICOMARU_DEMO_LOGIN === 'true';
/** レート制限用の接続元。本番はCloudflareが上書きする cf-connecting-ip だけを信頼する。 */
export const clientIp = (headers: Headers) =>
  localD1() ? '127.0.0.1' : (headers.get('cf-connecting-ip') ?? 'unknown');
