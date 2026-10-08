import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerClient, signInWithOtp } = vi.hoisted(() => ({
  createServerClient: vi.fn(), signInWithOtp: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: createServerClient }));

const SUPABASE_URL = 'https://supabase.example.test';
const EMAIL = 'private-email@example.test';
const IP = '192.0.2.45';
const SERVICE_KEY = 'private-service-role-key';

function request() {
  return new Request('http://app.test/api/auth/otp-request', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
    body: JSON.stringify({ email: EMAIL }),
  });
}

function transportError(code: string): TypeError {
  return new TypeError(`fetch failed: ${EMAIL}`, {
    cause: Object.assign(new Error(`${IP} ${SERVICE_KEY}`), { code }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  vi.stubEnv('PII_HMAC_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('APP_BASE_URL', 'http://app.test');
  signInWithOtp.mockReset().mockResolvedValue({ error: null });
  createServerClient.mockReset().mockResolvedValue({ auth: { signInWithOtp } });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function sendOtp() {
  const { POST } = await import('@/app/api/auth/otp-request/route');
  return POST(request());
}

function assertNoOtp() {
  expect(createServerClient).not.toHaveBeenCalled();
  expect(signInWithOtp).not.toHaveBeenCalled();
}

describe('実Supabase SDKを使ったOTP送信前のレート制限', () => {
  it('接続前タイムアウトから回復し、カウンタの完了は一回、OTP呼出しも一回', async () => {
    let completedChecks = 0;
    const nativeFetch = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(transportError('UND_ERR_CONNECT_TIMEOUT'))
      .mockImplementationOnce(async (input, init) => {
        const outgoing = new Request(input, init);
        expect(outgoing.url).toBe(`${SUPABASE_URL}/rest/v1/rpc/check_rate_limit`);
        expect(outgoing.method).toBe('POST');
        expect(outgoing.redirect).toBe('error');
        const body = await outgoing.json();
        expect(body).toMatchObject({ p_key_type: 'otp_request' });
        expect(body.p_key_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(body)).not.toContain(EMAIL);
        expect(JSON.stringify(body)).not.toContain(IP);
        completedChecks++;
        return Response.json(true);
      });
    vi.stubGlobal('fetch', nativeFetch);

    expect((await sendOtp()).status).toBe(204);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(completedChecks).toBe(1);
    expect(signInWithOtp).toHaveBeenCalledExactlyOnceWith({
      email: EMAIL,
      options: { shouldCreateUser: false, emailRedirectTo: 'http://app.test/login' },
    });
  });

  it('接続タイムアウトが続けば503を返し、メール送信に進まない', async () => {
    const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(transportError('UND_ERR_CONNECT_TIMEOUT'));
    vi.stubGlobal('fetch', nativeFetch);

    const response = await sendOtp();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: {
      code: 'SERVICE_UNAVAILABLE', message: expect.any(String), details: [],
    } });
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    assertNoOtp();
  });

  it.each(['UND_ERR_HEADERS_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET'])(
    '%s ではカウンタを再送せず503、メール送信もしない', async (code) => {
      const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(transportError(code));
      vi.stubGlobal('fetch', nativeFetch);

      const response = await sendOtp();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
      expect(nativeFetch).toHaveBeenCalledTimes(1);
      assertNoOtp();
    },
  );

  it.each([502, 503, 504])('上流HTTP %iは再試行せず503へ変換する', async (status) => {
    const nativeFetch = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response('private upstream response', { status }));
    vi.stubGlobal('fetch', nativeFetch);

    const response = await sendOtp();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    assertNoOtp();
  });

  it('カウンタ上限超過の429を維持し、メールを送信しない', async () => {
    const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json(false));
    vi.stubGlobal('fetch', nativeFetch);

    const response = await sendOtp();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    assertNoOtp();
  });

  it.each([
    ['42501', 403, 'FORBIDDEN'], ['XX000', 500, 'INTERNAL_ERROR'],
  ])('SQLSTATE %sは通信障害として扱わず既存ステータスを維持する', async (code, status, expectedCode) => {
    const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      code, message: `database private: ${EMAIL} ${SERVICE_KEY}`, details: IP,
    }, { status }));
    vi.stubGlobal('fetch', nativeFetch);

    const response = await sendOtp();
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code: expectedCode } });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    assertNoOtp();
  });

  it('SDKが生成した詳細例外やリクエストの秘密情報をログと応答へ出さない', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(transportError('UND_ERR_CONNECT_TIMEOUT')));
    const response = await sendOtp();
    const output = JSON.stringify({
      response: await response.json(),
      logs: [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls],
    });
    for (const secret of [EMAIL, IP, SERVICE_KEY, SUPABASE_URL]) expect(output).not.toContain(secret);
    expect(output).toContain('check_rate_limit');
  });

  it('レート制限用クライアントを使った後も他のService Role用途には再試行を広げない', async () => {
    const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(transportError('UND_ERR_CONNECT_TIMEOUT'));
    vi.stubGlobal('fetch', nativeFetch);
    const { createSupabaseAdminClient } = await import('@/lib/supabase/admin');
    const rateLimitClient = createSupabaseAdminClient('auth.rate-limit');
    const otherClient = createSupabaseAdminClient('admin.venues');
    expect(otherClient).not.toBe(rateLimitClient);

    const result = await otherClient.rpc('check_rate_limit', { p_key_hash: 'private-hash' });
    expect(result.status).toBe(0);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('検証前の失効判定が通信できなければ503となる', async () => {
    const nativeFetch = vi.fn<typeof fetch>().mockRejectedValue(transportError('ECONNRESET'));
    vi.stubGlobal('fetch', nativeFetch);
    const { isOtpCodeInvalidated } = await import('@/app/api/auth/shared');

    await expect(isOtpCodeInvalidated(EMAIL)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('失敗回数の記録・消去が失敗しても生のDBエラーをログへ出さない', async () => {
    const nativeFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      code: `private-code-${EMAIL}`, message: `${EMAIL} ${SERVICE_KEY}`, details: IP, hint: 'private-hash',
    }, { status: 500 }));
    vi.stubGlobal('fetch', nativeFetch);
    const { recordOtpVerifyFailure, clearOtpVerifyFailures } = await import('@/app/api/auth/shared');

    await expect(recordOtpVerifyFailure(EMAIL)).resolves.toBeUndefined();
    await expect(clearOtpVerifyFailures(EMAIL)).resolves.toBeUndefined();
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalled();
    const logs = JSON.stringify(vi.mocked(console.warn).mock.calls);
    for (const secret of [EMAIL, IP, SERVICE_KEY, 'private-hash']) expect(logs).not.toContain(secret);
  });
});
