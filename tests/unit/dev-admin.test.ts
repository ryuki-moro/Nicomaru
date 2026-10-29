import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDevAdminConfig, isDevAdminRequestAllowed, isLoopbackHost } from '@/lib/auth/dev-admin';

function request(
  overrides: Record<string, string> = {},
  url = 'http://127.0.0.1:3002/api/auth/dev-admin',
) {
  return new Request(url, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3002',
      origin: 'http://127.0.0.1:3002',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      ...overrides,
    },
  });
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DEV_ADMIN_LOGIN_ENABLED', 'true');
  vi.stubEnv('DEV_ADMIN_EMAIL', 'dev@example.test');
  vi.stubEnv('DEV_ADMIN_PASSWORD', 'example-test-password');
  vi.stubEnv('DEV_ADMIN_AUTH_USER_ID', 'dev-auth-user');
});
afterEach(() => vi.unstubAllEnvs());

describe('開発用adminの有効化', () => {
  it('開発環境で設定が揃った場合だけ利用できる', () => {
    expect(getDevAdminConfig()?.authUserId).toBe('dev-auth-user');
  });

  it.each(['production', 'test'])('%s ではflagが有効でも拒否する', (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    expect(getDevAdminConfig()).toBeNull();
  });

  it.each([
    'DEV_ADMIN_LOGIN_ENABLED',
    'DEV_ADMIN_EMAIL',
    'DEV_ADMIN_PASSWORD',
    'DEV_ADMIN_AUTH_USER_ID',
  ])('%s がなければ利用できない', (key) => {
    vi.stubEnv(key, '');
    expect(getDevAdminConfig()).toBeNull();
  });
});

describe('開発用adminのリクエスト境界', () => {
  it.each(['localhost:3002', '127.0.0.1:3002', '[::1]:3002'])('%s はloopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });
  it.each([
    'example.com',
    'localhost.evil.test',
    '127.0.0.2',
    '192.168.0.1',
    'user@localhost',
    'localhost/path',
    '',
  ])('%s をloopbackとして扱わない', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
  it('同一OriginのJSON POSTを受け付ける', () => {
    expect(isDevAdminRequestAllowed(request())).toBe(true);
  });
  it('GETではセッションを作成できない', () => {
    const post = request();
    expect(isDevAdminRequestAllowed(new Request(post.url, { headers: post.headers }))).toBe(false);
  });
  it('Next.jsが内部URLをlocalhostに正規化しても実際のHostとの同一Originを確認する', () => {
    expect(isDevAdminRequestAllowed(request({}, 'http://localhost:3002/api/auth/dev-admin'))).toBe(
      true,
    );
  });
  it('内部URLと異なるポートは拒否する', () => {
    expect(isDevAdminRequestAllowed(request({}, 'http://localhost:3003/api/auth/dev-admin'))).toBe(
      false,
    );
  });
  it.each<Record<string, string>>([
    { origin: '' },
    { origin: 'https://evil.test' },
    { origin: 'http://127.0.0.1:3000' },
    { host: 'example.com' },
    { host: 'localhost:3002' },
    { 'content-type': 'text/plain' },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-forwarded-host': 'evil.test' },
    { 'x-forwarded-for': '192.168.0.10' },
    { 'x-forwarded-for': '127.0.0.1, 192.168.0.10' },
  ])('Origin・Host・送信形式・外部接続の偽装を拒否する: %j', (headers) => {
    expect(isDevAdminRequestAllowed(request(headers))).toBe(false);
  });
  it('外部URLはHostとOriginを揃えても拒否する', () => {
    expect(
      isDevAdminRequestAllowed(
        request(
          { host: 'evil.test', origin: 'http://evil.test' },
          'http://evil.test/api/auth/dev-admin',
        ),
      ),
    ).toBe(false);
  });
  it('Next.jsが付けるloopbackの転送ヘッダーを受け付ける', () => {
    expect(
      isDevAdminRequestAllowed(
        request({
          'x-forwarded-host': '127.0.0.1:3002',
          'x-forwarded-for': '127.0.0.1',
        }),
      ),
    ).toBe(true);
  });
});
