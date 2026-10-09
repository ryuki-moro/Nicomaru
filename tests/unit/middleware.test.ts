import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleware } from '@/middleware';

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

beforeEach(() => {
  vi.stubEnv('APP_BASE_URL', undefined);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
  getUser.mockReset().mockResolvedValue({ data: { user: null } });
});
afterEach(() => vi.unstubAllEnvs());

describe('未ログイン時のログイン先', () => {
  it('Next.jsがループバックURLを正規化しても設定した127.0.0.1へ戻す', async () => {
    vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3000');
    const request = new NextRequest('http://127.0.0.1:3000/venues/venue-id');
    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://127.0.0.1:3000/login?next=%2Fvenues%2Fvenue-id',
    );
  });

  it('HTTPSの公開URLを使い、設定中のパス・クエリ・フラグメントを持ち込まない', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.example.test/base?setting=1#fragment');
    const response = await middleware(new NextRequest('http://internal.test/venues'));

    expect(response.headers.get('location')).toBe('https://app.example.test/login?next=%2Fvenues');
  });

  it('公開URLが未設定ならリクエストURLを使う', async () => {
    const response = await middleware(new NextRequest('https://preview.example.test/venues'));

    expect(response.headers.get('location')).toBe(
      'https://preview.example.test/login?next=%2Fvenues',
    );
  });

  it('Host・転送ヘッダーで設定済みのログイン先を変更できない', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.example.test');
    const response = await middleware(
      new NextRequest('http://internal.test/venues', {
        headers: {
          host: 'evil.example.test',
          'x-forwarded-host': 'evil.example.test',
          'x-forwarded-proto': 'https',
        },
      }),
    );

    expect(response.headers.get('location')).toBe('https://app.example.test/login?next=%2Fvenues');
  });

  it('保護パスをnextにエンコードし、元のクエリを引き継がない', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.example.test');
    const response = await middleware(
      new NextRequest(
        'https://app.example.test/venues/%2F%2Fevil.example.test?next=https://evil.example.test&token=private',
      ),
    );
    const target = new URL(response.headers.get('location')!);

    expect(target.origin).toBe('https://app.example.test');
    expect(target.pathname).toBe('/login');
    expect([...target.searchParams]).toEqual([['next', '/venues/%2F%2Fevil.example.test']]);
  });

  it('ルートからのログインにはnextを付けない', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.example.test');
    const response = await middleware(new NextRequest('https://app.example.test/?next=/venues'));

    expect(response.headers.get('location')).toBe('https://app.example.test/login');
  });

  it.each(['', 'not-a-url', 'javascript:alert(1)', 'https://user:password@app.example.test'])(
    '不正な公開URL設定 %s では別のログイン先へフォールバックしない',
    async (configured) => {
      vi.stubEnv('APP_BASE_URL', configured);
      const response = await middleware(new NextRequest('https://app.example.test/venues'));

      expect(response.status).toBe(500);
      expect(response.headers.has('location')).toBe(false);
      expect(await response.text()).toBe(
        'ログイン先の設定に問題があります。管理者にお問い合わせください。',
      );
    },
  );
});

describe('ログイン先へ転送しない経路', () => {
  it.each([
    '/login',
    '/password',
    '/register',
    '/error',
    '/api/auth/otp-request',
    '/api/venues/id',
  ])('公開画面・API %s の処理はそのまま継続する', async (path) => {
    vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3000');
    const response = await middleware(new NextRequest(`http://127.0.0.1:3000${path}`));

    expect(response.status).toBe(200);
    expect(response.headers.has('location')).toBe(false);
  });

  it('認証済み利用者は保護画面へ進める', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-id' } } });
    const response = await middleware(new NextRequest('https://app.example.test/venues'));

    expect(response.status).toBe(200);
    expect(response.headers.has('location')).toBe(false);
  });
});
