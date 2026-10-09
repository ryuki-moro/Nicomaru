import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthRateLimitFetch } from '@/lib/supabase/auth-rate-limit-fetch';

const BASE_URL = 'https://supabase.example.test';
const RPC_URL = `${BASE_URL}/rest/v1/rpc/check_rate_limit`;
const requestInit: RequestInit = { method: 'POST', body: '{"p_key_hash":"private-hash"}' };

function transportError(code: string): TypeError {
  return new TypeError('fetch failed: private-email@example.test', {
    cause: Object.assign(new Error('private-service-key 192.0.2.45'), { code }),
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('認証レート制限RPCの接続失敗リトライ', () => {
  it.each(['check_rate_limit', 'peek_rate_limit', 'clear_rate_limit'])(
    '接続前タイムアウトだけを一度再試行し、%s の本文とヘッダーを維持する',
    async (operation) => {
      const response = Response.json(true);
      const nativeFetch = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(transportError('UND_ERR_CONNECT_TIMEOUT'))
        .mockResolvedValueOnce(response);
      vi.stubGlobal('fetch', nativeFetch);
      const wrapped = createAuthRateLimitFetch(BASE_URL);
      const init = { ...requestInit, headers: { authorization: 'Bearer private-service-key' } };

      await expect(wrapped(`${BASE_URL}/rest/v1/rpc/${operation}`, init)).resolves.toBe(response);
      expect(nativeFetch).toHaveBeenCalledTimes(2);
      for (const [, outgoing] of nativeFetch.mock.calls) {
        expect(outgoing).toMatchObject({ ...init, redirect: 'error' });
      }
    },
  );

  it('連続する接続タイムアウトは二回で打ち切る', async () => {
    const error = transportError('UND_ERR_CONNECT_TIMEOUT');
    const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(error);
    vi.stubGlobal('fetch', nativeFetch);

    await expect(createAuthRateLimitFetch(BASE_URL)(RPC_URL, requestInit)).rejects.toBe(error);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ETIMEDOUT',
    'ECONNRESET',
    'UND_ERR_SOCKET',
  ])('実行済みか判断できない %s は再送しない', async (code) => {
    const error = transportError(code);
    const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(error);
    vi.stubGlobal('fetch', nativeFetch);

    await expect(createAuthRateLimitFetch(BASE_URL)(RPC_URL, requestInit)).rejects.toBe(error);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 503, 504])(
    'HTTP %i 応答は実行済みの可能性があるため再送しない',
    async (status) => {
      const response = new Response('upstream failure', { status });
      const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
      vi.stubGlobal('fetch', nativeFetch);

      await expect(createAuthRateLimitFetch(BASE_URL)(RPC_URL, requestInit)).resolves.toBe(
        response,
      );
      expect(nativeFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('初回送信後に中断されたリクエストは接続タイムアウトでも再送しない', async () => {
    const controller = new AbortController();
    const error = transportError('UND_ERR_CONNECT_TIMEOUT');
    const nativeFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw error;
    });
    vi.stubGlobal('fetch', nativeFetch);

    await expect(
      createAuthRateLimitFetch(BASE_URL)(RPC_URL, {
        ...requestInit,
        signal: controller.signal,
      }),
    ).rejects.toBe(error);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('TypeError ではない例外の同名コードを再試行の根拠にしない', async () => {
    const error = new Error('application failure', {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(error);
    vi.stubGlobal('fetch', nativeFetch);

    await expect(createAuthRateLimitFetch(BASE_URL)(RPC_URL, requestInit)).rejects.toBe(error);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['別オリジン', 'https://foreign.example.test/rest/v1/rpc/check_rate_limit', requestInit],
    ['別RPC', `${BASE_URL}/rest/v1/rpc/log_audit`, requestInit],
    ['認証API', `${BASE_URL}/auth/v1/otp`, requestInit],
    ['別HTTPメソッド', RPC_URL, { ...requestInit, method: 'GET', body: undefined }],
    ['再利用できない本文', RPC_URL, { ...requestInit, body: new FormData() }],
  ] as const)('%s にはこの再試行を適用しない', async (_label, url, init) => {
    const error = transportError('UND_ERR_CONNECT_TIMEOUT');
    const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(error);
    vi.stubGlobal('fetch', nativeFetch);

    await expect(createAuthRateLimitFetch(BASE_URL)(url, init)).rejects.toBe(error);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('ログへエラー本文・メール・IP・認証キー・カウンタキーを出さない', async () => {
    const nativeFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(transportError('untrusted-private-error-code'));
    vi.stubGlobal('fetch', nativeFetch);

    await expect(
      createAuthRateLimitFetch(BASE_URL)(RPC_URL, {
        ...requestInit,
        headers: { authorization: 'Bearer private-service-key' },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    const logs = JSON.stringify([
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(logs).toContain('check_rate_limit');
    for (const privateValue of [
      'private-email@example.test',
      '192.0.2.45',
      'private-service-key',
      'private-hash',
      'untrusted-private-error-code',
      BASE_URL,
    ])
      expect(logs).not.toContain(privateValue);
  });
});
