import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ server: vi.fn(), fetch: vi.fn<typeof fetch>() }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: mocks.server }));
import { GET } from '@/app/api/health/route';

function reply(status: number, body: unknown) {
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.server.mockResolvedValue(
    createClient('http://127.0.0.1:54321', 'fixture-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: mocks.fetch },
    }),
  );
});

describe('DB接続の死活確認', () => {
  it('データも件数も取得せず、DBからの正常応答を確認する', async () => {
    reply(200, []);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const [input, options] = mocks.fetch.mock.calls[0];
    const url = new URL(String(input));
    expect(options?.method).toBe('GET');
    expect(url.searchParams.get('limit')).toBe('0');
    expect(url.searchParams.get('select')).toBe('id');
    expect(new Headers(options?.headers).get('prefer') ?? '').not.toContain('count=');
  });

  it.each([401, 403])(
    'SQLSTATE 42501 / HTTP %iはDBが応答した証拠として正常とする',
    async (status) => {
      reply(status, { code: '42501', message: 'permission denied for table venues' });
      const response = await GET();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    },
  );

  it.each([
    [401, 'PGRST301'],
    [401, undefined],
    [404, 'PGRST205'],
    [500, '42P01'],
    [503, '08006'],
  ])('認証/スキーマ/DB接続の失敗を権限拒否と混同しない (%i %s)', async (status, code) => {
    reply(Number(status), { code, message: 'private internal detail' });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it('通信失敗でも内部情報を返さない', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('private network detail'));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it('クライアント設定の不足を成功にしない', async () => {
    mocks.server.mockRejectedValue(new Error('missing secret configuration'));
    expect((await GET()).status).toBe(503);
  });
});
