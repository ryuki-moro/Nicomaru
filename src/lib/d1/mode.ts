/** d1: Cloudflare Workers上の本番。d1-local: ループバック限定のローカル検証（外部送信なし）。 */
export const usingD1 = () =>
  process.env.NICOMARU_DB === 'd1' || process.env.NICOMARU_DB === 'd1-local';
export const localD1 = () => process.env.NICOMARU_DB === 'd1-local';
// クライアントではNEXT_PUBLIC_の値がビルド時に埋め込まれる。
export const publicD1 = () =>
  process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1' ||
  process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1-local';
export const publicLocalD1 = () => process.env.NEXT_PUBLIC_NICOMARU_DB === 'd1-local';
/** レート制限用の接続元。本番はCloudflareが上書きする cf-connecting-ip だけを信頼する。 */
export const clientIp = (headers: Headers) =>
  localD1() ? '127.0.0.1' : (headers.get('cf-connecting-ip') ?? 'unknown');
