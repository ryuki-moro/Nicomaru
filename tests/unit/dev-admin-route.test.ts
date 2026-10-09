import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), profile: vi.fn(),
  createServerClient: vi.fn(), setSession: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: mocks.createServerClient }));

import { POST } from '@/app/api/auth/dev-admin/route';

function request(headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3002/api/auth/dev-admin', {
    method: 'POST',
    headers: { host: '127.0.0.1:3002', origin: 'http://127.0.0.1:3002', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ role: 'system_admin', email: 'ignored@example.test', redirectTo: 'https://evil.test' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DEV_ADMIN_LOGIN_ENABLED', 'true');
  vi.stubEnv('DEV_ADMIN_EMAIL', 'dev@example.test');
  vi.stubEnv('DEV_ADMIN_PASSWORD', 'private-test-password');
  vi.stubEnv('DEV_ADMIN_AUTH_USER_ID', 'dev-auth-user');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  mocks.signIn.mockResolvedValue({ error: null, data: {
    user: { id: 'dev-auth-user' }, session: { access_token: 'private-access-token', refresh_token: 'private-refresh-token' },
  } });
  mocks.profile.mockResolvedValue({ error: null, data: { role: 'admin', status: 'active', venue_id: 'venue-id' } });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.setSession.mockResolvedValue({ error: null });
  mocks.createClient.mockReturnValue({
    auth: { signInWithPassword: mocks.signIn, signOut: mocks.signOut },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }),
  });
  mocks.createServerClient.mockResolvedValue({ auth: { setSession: mocks.setSession } });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/auth/dev-admin', () => {
  it('確認済みの専用adminだけにCookieを発行し、応答に秘密情報を含めない', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/dashboard' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.signIn).toHaveBeenCalledWith({ email: 'dev@example.test', password: 'private-test-password' });
    expect(mocks.setSession).toHaveBeenCalledWith({ access_token: 'private-access-token', refresh_token: 'private-refresh-token' });
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('productionでは設定済みでも認証APIを呼ばない', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await POST(request())).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it('通常起動では利用できない', async () => {
    vi.stubEnv('DEV_ADMIN_LOGIN_ENABLED', '');
    expect((await POST(request())).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it('別Originからは認証APIを呼ばない', async () => {
    expect((await POST(request({ origin: 'https://evil.test' }))).status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it('認証に失敗した場合はCookieを発行しない', async () => {
    mocks.signIn.mockResolvedValue({ error: { message: 'private-provider-error' }, data: { user: null, session: null } });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-provider-error');
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });
  it('指定外のAuthユーザーにはCookieを発行しない', async () => {
    mocks.signIn.mockResolvedValue({ error: null, data: {
      user: { id: 'another-user' }, session: { access_token: 'token', refresh_token: 'refresh' },
    } });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
  it.each([
    { role: 'planner', status: 'active', venue_id: 'venue' },
    { role: 'system_admin', status: 'active', venue_id: null },
    { role: 'admin', status: 'suspended', venue_id: 'venue' },
    { role: 'admin', status: 'invited', venue_id: 'venue' },
    { role: 'admin', status: 'active', venue_id: null },
    null,
  ])('利用できないプロフィールにはCookieを発行しない: %j', async (profile) => {
    mocks.profile.mockResolvedValue({ data: profile, error: null });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
  it('プロフィールの取得失敗も拒否する', async () => {
    mocks.profile.mockResolvedValue({ data: null, error: { message: 'DB unavailable' } });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });
  it('Cookieの確立に失敗した場合は一時セッションを取り消す', async () => {
    mocks.setSession.mockResolvedValue({ error: { message: 'expired' } });
    expect((await POST(request())).status).toBe(500);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
