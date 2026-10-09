import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  server: vi.fn(),
  admin: vi.fn(),
  adminRpc: vi.fn(),
  rpc: vi.fn(),
  rateLimit: vi.fn(),
  signIn: vi.fn(),
  updateUser: vi.fn(),
  getUser: vi.fn(),
  profile: vi.fn(),
  resetPassword: vi.fn(),
  verifyOtp: vi.fn(),
  recordOtp: vi.fn(),
  clearOtp: vi.fn(),
  invalidated: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: mocks.server }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: mocks.admin,
  verifyInternalCronSecret: () => false,
}));
vi.mock('@/app/api/auth/shared', () => ({
  enforceAuthRateLimit: mocks.rateLimit,
  appBaseUrl: () => 'https://app.test',
  recordOtpVerifyFailure: mocks.recordOtp,
  clearOtpVerifyFailures: mocks.clearOtp,
  isOtpCodeInvalidated: mocks.invalidated,
}));
import { POST as login } from '@/app/api/auth/password-login/route';
import { POST as updatePassword } from '@/app/api/auth/password-update/route';
import { POST as resetPassword } from '@/app/api/auth/password-reset/route';
import { POST as verifyOtp } from '@/app/api/auth/otp-verify/route';

const EMAIL = 'private.person@example.test';
const PASSWORD = 'private-password-123!';
function request(path: string, body: unknown, origin = 'https://app.test') {
  return new Request(`https://app.test/api/auth/${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function assertNoPrivateLogs() {
  const logs = JSON.stringify([
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]);
  expect(logs).not.toContain(EMAIL);
  expect(logs).not.toContain(PASSWORD);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_BASE_URL', 'https://app.test');
  vi.stubEnv('PII_HMAC_KEY', Buffer.alloc(32, 8).toString('base64'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.admin.mockReturnValue({ rpc: mocks.adminRpc });
  mocks.adminRpc.mockResolvedValue({ data: 1, error: null });
  mocks.signIn.mockResolvedValue({ data: { user: { id: 'auth-id' } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'auth-id' } }, error: null });
  mocks.updateUser.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.resetPassword.mockResolvedValue({ error: null });
  mocks.verifyOtp.mockResolvedValue({
    data: { user: null },
    error: { code: 'otp_expired', status: 403 },
  });
  mocks.invalidated.mockResolvedValue(false);
  mocks.profile.mockResolvedValue({ data: { role: 'planner', status: 'active' }, error: null });
  mocks.server.mockResolvedValue({
    auth: {
      signInWithPassword: mocks.signIn,
      getUser: mocks.getUser,
      updateUser: mocks.updateUser,
      resetPasswordForEmail: mocks.resetPassword,
      verifyOtp: mocks.verifyOtp,
    },
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('パスワードログイン', () => {
  it('同一Originとレート制限を通して本人セッションを発行する', async () => {
    const req = request('password-login', { email: EMAIL, password: PASSWORD });
    const response = await login(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/' });
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith(req, 'password_login', EMAIL);
    expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith({ email: EMAIL, password: PASSWORD });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
  it('誤資格情報は同じ401で返し、監査にはHMACのみ渡す', async () => {
    mocks.signIn.mockResolvedValue({
      data: { user: null },
      error: { code: 'invalid_credentials', status: 400 },
    });
    const response = await login(request('password-login', { email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { message: 'メールアドレスまたはパスワードが正しくありません' },
    });
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith('audit.auth-event');
    expect(mocks.adminRpc).toHaveBeenCalledExactlyOnceWith('record_auth_failure', {
      p_account_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_method: 'password',
    });
    expect(JSON.stringify(mocks.adminRpc.mock.calls)).not.toContain(EMAIL);
    assertNoPrivateLogs();
  });
  it('監査障害でも認証失敗を成功やDB障害に変えない', async () => {
    mocks.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400 } });
    mocks.adminRpc.mockRejectedValue(new Error(`${EMAIL} ${PASSWORD}`));
    const response = await login(request('password-login', { email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(401);
    expect(console.warn).toHaveBeenCalledTimes(1);
    assertNoPrivateLogs();
  });
  it.each([500, 503])(
    '認証サービスの%iエラーは失敗監査のアカウント件数に加算しない',
    async (status) => {
      mocks.signIn.mockResolvedValue({ data: { user: null }, error: { status, message: EMAIL } });
      expect(
        (await login(request('password-login', { email: EMAIL, password: PASSWORD }))).status,
      ).toBe(503);
      expect(mocks.adminRpc).not.toHaveBeenCalled();
      assertNoPrivateLogs();
    },
  );
  it('Auth通信例外の本文をログへ出さず503とする', async () => {
    mocks.signIn.mockRejectedValue(new Error(`${EMAIL} ${PASSWORD}`));
    expect(
      (await login(request('password-login', { email: EMAIL, password: PASSWORD }))).status,
    ).toBe(503);
    assertNoPrivateLogs();
  });
  it('Auth側の429は資格情報誤りと数えず429を維持する', async () => {
    mocks.signIn.mockResolvedValue({ data: { user: null }, error: { status: 429 } });
    expect(
      (await login(request('password-login', { email: EMAIL, password: PASSWORD }))).status,
    ).toBe(429);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
  it('不正Origin/過大本文/不正入力は認証やDBを呼ばない', async () => {
    expect(
      (
        await login(
          request('password-login', { email: EMAIL, password: PASSWORD }, 'https://foreign.test'),
        )
      ).status,
    ).toBe(403);
    expect(
      (await login(request('password-login', { email: EMAIL, password: 'x'.repeat(20000) })))
        .status,
    ).toBe(400);
    expect(
      (await login(request('password-login', { email: 'invalid', password: '' }))).status,
    ).toBe(400);
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });
});

describe('パスワード更新', () => {
  const body = { password: PASSWORD, passwordConfirm: PASSWORD };
  it.each(['active', 'invited'])('%sのstaff本人だけ更新して監査を完了まで待つ', async (status) => {
    mocks.profile.mockResolvedValue({ data: { role: 'planner', status }, error: null });
    expect((await updatePassword(request('password-update', body))).status).toBe(204);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.updateUser).toHaveBeenCalledExactlyOnceWith({ password: PASSWORD });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('audit_password_changed');
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('本人未認証ではAuth更新しない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await updatePassword(request('password-update', body))).status).toBe(401);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it.each([
    { role: 'couple', status: 'active' },
    { role: 'planner', status: 'suspended' },
    { role: 'admin', status: 'deleted' },
  ])('$role/$statusではAuth更新しない', async (profile) => {
    mocks.profile.mockResolvedValue({ data: profile, error: null });
    expect((await updatePassword(request('password-update', body))).status).toBe(403);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it('弱いパスワードは拒否して成功監査を残さない', async () => {
    mocks.updateUser.mockResolvedValue({ error: { code: 'weak_password' } });
    const response = await updatePassword(request('password-update', body));
    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('監査障害は更新完了の応答を維持し秘密をログへ出さない', async () => {
    mocks.rpc.mockRejectedValue(new Error(`${EMAIL} ${PASSWORD}`));
    expect((await updatePassword(request('password-update', body))).status).toBe(204);
    assertNoPrivateLogs();
  });
  it('不正Originと確認欄不一致はAuthを呼ばない', async () => {
    expect((await updatePassword(request('password-update', body, 'null'))).status).toBe(403);
    const response = await updatePassword(
      request('password-update', { ...body, passwordConfirm: 'other' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { details: [{ field: 'passwordConfirm' }] },
    });
    expect(mocks.server).not.toHaveBeenCalled();
  });
});

describe('既存認証経路の監査', () => {
  it('再設定要求は存否や送信成否を漏らさず固定イベントだけを記録', async () => {
    expect((await resetPassword(request('password-reset', { email: EMAIL }))).status).toBe(204);
    expect(mocks.adminRpc).toHaveBeenCalledExactlyOnceWith('record_password_reset_request');
    expect(JSON.stringify(mocks.adminRpc.mock.calls)).not.toContain(EMAIL);
  });
  it('OTP誤りも同じHMACアカウントへ加算する', async () => {
    expect((await verifyOtp(request('otp-verify', { email: EMAIL, code: '123456' }))).status).toBe(
      422,
    );
    const otpHash = mocks.adminRpc.mock.calls[0][1].p_account_hash;
    mocks.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400 } });
    await login(request('password-login', { email: EMAIL, password: PASSWORD }));
    expect(mocks.adminRpc.mock.calls[1][1].p_account_hash).toBe(otpHash);
    expect(mocks.recordOtp).toHaveBeenCalledExactlyOnceWith(EMAIL);
  });
  it('失効済みOTPへの継続試行も失敗監査に数えるがAuth検証はしない', async () => {
    mocks.invalidated.mockResolvedValue(true);
    expect((await verifyOtp(request('otp-verify', { email: EMAIL, code: '123456' }))).status).toBe(
      422,
    );
    expect(mocks.adminRpc).toHaveBeenCalledWith(
      'record_auth_failure',
      expect.objectContaining({ p_method: 'otp' }),
    );
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });
});
