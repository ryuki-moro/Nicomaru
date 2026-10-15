/** 接続前の失敗だけを再試行する、認証レート制限 RPC 専用の fetch。 */
const OPERATIONS = new Set(['check_rate_limit', 'peek_rate_limit', 'clear_rate_limit']);
const TRANSPORT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
]);

function transportCode(error: unknown): string {
  if (!(error instanceof Error)) return 'FETCH_FAILED';
  if (error.name === 'AbortError') return 'ABORT_ERR';
  const cause = error.cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && TRANSPORT_CODES.has(code) ? code : 'FETCH_FAILED';
}

export function createAuthRateLimitFetch(supabaseUrl: string): typeof fetch {
  const rpcBase = new URL('rest/v1/rpc/', `${supabaseUrl.replace(/\/+$/, '')}/`);

  return async (input, init) => {
    // SDK が作る再利用可能な JSON POST だけを対象にする。Request/stream は再送しない。
    if (
      !(typeof input === 'string' || input instanceof URL) ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    ) {
      return fetch(input, init);
    }
    const url = new URL(input);
    const operation = url.pathname.slice(rpcBase.pathname.length);
    if (
      url.origin !== rpcBase.origin ||
      !url.pathname.startsWith(rpcBase.pathname) ||
      url.search ||
      !OPERATIONS.has(operation)
    ) {
      return fetch(input, init);
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        // redirect 後の接続失敗では、元の POST が既に実行された可能性がある。
        return await fetch(input, { ...init, redirect: 'error' });
      } catch (error) {
        const code = transportCode(error);
        // Undici の接続タイマーは connect/secureConnect 完了時に解除される。
        // 読み取り失敗・HTTP 応答・一般的なタイムアウトは二重加算を避けるため再送しない。
        const retrying =
          attempt === 1 &&
          error instanceof TypeError &&
          code === 'UND_ERR_CONNECT_TIMEOUT' &&
          !init.signal?.aborted;
        console.warn('[auth.rate-limit] transport failure', { operation, code, attempt, retrying });
        if (!retrying) throw error;
      }
    }
  };
}
