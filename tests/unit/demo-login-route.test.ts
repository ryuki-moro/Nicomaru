import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signIn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/d1/auth', () => ({ signInD1WithPassword: signIn }));

import { POST } from '@/app/api/auth/demo-login/route';

function request(role: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3104/api/auth/demo-login', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3104',
      origin: 'http://127.0.0.1:3104',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ role }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NICOMARU_DB', 'd1-local');
  vi.stubEnv('NICOMARU_DEMO_LOGIN', 'true');
  vi.stubEnv('DEMO_PLANNER_EMAIL', 'planner@example.test');
  vi.stubEnv('DEMO_COUPLE_EMAIL', 'couple@example.test');
  vi.stubEnv('DEMO_LOGIN_PASSWORD', 'demo-test-password');
  signIn.mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'set-cookie': 'session=demo; HttpOnly' } }),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/auth/demo-login', () => {
  it.each([
    ['planner', 'planner@example.test'],
    ['couple', 'couple@example.test'],
  ])('%s のデモアカウントで認証しCookieを渡す', async (role, email) => {
    const response = await POST(request(role));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: '/' });
    expect(response.headers.get('set-cookie')).toContain('session=demo');
    expect(signIn).toHaveBeenCalledWith(email, 'demo-test-password', '127.0.0.1');
  });

  it.each([
    ['NICOMARU_DEMO_LOGIN', 'false'],
    ['NICOMARU_DB', 'd1'],
    ['NICOMARU_DB', 'unsupported'],
  ])('%s=%s では存在しない扱いにする', async (key, value) => {
    vi.stubEnv(key, value);
    expect((await POST(request('planner'))).status).toBe(404);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('認証のレート制限は429として返す', async () => {
    signIn.mockResolvedValue(new Response('{}', { status: 429 }));
    expect((await POST(request('planner'))).status).toBe(429);
  });

  it('別オリジンからの要求と未知の役割は拒否する', async () => {
    expect((await POST(request('planner', { origin: 'https://evil.test' }))).status).toBe(403);
    expect((await POST(request('admin'))).status).toBe(400);
    expect(signIn).not.toHaveBeenCalled();
  });
});
