/// <reference types="vite/client" />
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { route } from '@/lib/api/route';
import { ApiError } from '@/lib/errors';

const { admin, server, authenticate } = vi.hoisted(() => ({
  admin: vi.fn(), server: vi.fn(), authenticate: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin')>(),
  createSupabaseAdminClient: admin,
}));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: server }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth/session')>(),
  requireAppUser: authenticate, requireRole: authenticate, requireStaff: authenticate,
}));

const ORIGIN = 'https://app.test';
const SECRET = 'unit-only-internal-secret';
const moduleLoaders = import.meta.glob<Record<string, unknown>>('../../src/app/api/**/route.ts');
const internalRoutes = new Set([
  '/api/internal/ai-job-reclaim', '/api/internal/case-purge',
  '/api/internal/notifications-dispatch', '/api/internal/rate-limit-cleanup',
  '/api/internal/risk-recalculate',
]);
const webhookPath = '/api/line/webhook';
const unsafeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

beforeEach(() => {
  vi.stubEnv('APP_BASE_URL', ORIGIN);
  vi.stubEnv('INTERNAL_CRON_SECRET', SECRET);
  vi.stubEnv('LINE_CHANNEL_SECRET', 'unit-only-line-secret');
  admin.mockReset().mockImplementation(() => { throw new ApiError('UNPROCESSABLE', 'test sentinel'); });
  server.mockReset().mockImplementation(() => { throw new ApiError('UNPROCESSABLE', 'test sentinel'); });
  authenticate.mockReset().mockImplementation(() => { throw new ApiError('UNAUTHENTICATED'); });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('External calls are forbidden in this test')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('共通RouteのOrigin検証', () => {
  it.each(unsafeMethods)('%sの不正Originは本文を読む前・handler実行前に拒否する', async (method) => {
    const handler = vi.fn(async (request: Request) => { await request.text(); return new Response(); });
    const wrapped = route(handler);
    for (const origin of [undefined, 'null', 'https://foreign.test']) {
      const request = new Request(`${ORIGIN}/api/test`, {
        method, headers: origin ? { origin } : {}, body: '{broken json',
      });
      const response = await wrapped(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(request.bodyUsed).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(unsafeMethods)('%sの同一Originでは本文とRouteContextをそのまま渡す', async (method) => {
    const context = { params: Promise.resolve({ id: 'target' }) };
    const handler = vi.fn(async (request: Request, actualContext: typeof context) =>
      Response.json({ body: await request.text(), id: (await actualContext.params).id }));
    const request = new Request(`${ORIGIN}/api/test`, {
      method, headers: { origin: ORIGIN }, body: 'original body',
    });
    const response = await route(handler)(request, context);
    expect(await response.json()).toEqual({ body: 'original body', id: 'target' });
    expect(handler).toHaveBeenCalledExactlyOnceWith(request, context);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('%sはOriginなしで既存処理を呼ぶ', async (method) => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    expect((await route(handler)(new Request(`${ORIGIN}/api/test`, { method }))).status).toBe(204);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('不正な公開Originの設定では本文を読まず拒否する', async () => {
    vi.stubEnv('APP_BASE_URL', '');
    const handler = vi.fn(async () => new Response());
    const response = await route(handler)(new Request(`${ORIGIN}/api/test`, {
      method: 'POST', headers: { origin: ORIGIN },
    }));
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('内部指定も認証を省略せず、共有secretを必須にする', async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const wrapped = route(handler, { source: 'internal-cron' });
    const rejectedHeaders: HeadersInit[] = [{}, { origin: ORIGIN }, { 'x-internal-cron-secret': 'wrong' }];
    for (const headers of rejectedHeaders) {
      const result = await wrapped(new Request(`${ORIGIN}/api/internal/test`, { method: 'POST', headers }));
      expect(result.status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
    const request = new Request(`${ORIGIN}/api/internal/test`, {
      method: 'POST', headers: { 'x-internal-cron-secret': SECRET },
    });
    expect((await wrapped(request)).status).toBe(204);
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('内部secretを持っていてもブラウザーAPIのOrigin検証は免除しない', async () => {
    const handler = vi.fn(async () => new Response());
    const request = new Request(`${ORIGIN}/api/test`, {
      method: 'POST', headers: { 'x-internal-cron-secret': SECRET },
    });
    expect((await route(handler)(request)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('共有secret自体が未設定なら内部指定でも拒否する', async () => {
    vi.stubEnv('INTERNAL_CRON_SECRET', undefined);
    const handler = vi.fn(async () => new Response());
    const request = new Request(`${ORIGIN}/api/internal/test`, {
      method: 'POST', headers: { 'x-internal-cron-secret': SECRET },
    });
    expect((await route(handler, { source: 'internal-cron' })(request)).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('全APIの適用範囲（新規Routeも自動列挙）', () => {
  it('全28ブラウザー更新APIで不正Originを拒否し、認証・DB・外部通信を呼ばない', async () => {
    const checked: string[] = [];
    for (const [file, load] of Object.entries(moduleLoaders)) {
      const path = file.replace('../../src/app', '').replace('/route.ts', '');
      if (internalRoutes.has(path) || path === webhookPath) continue;
      const routeModule = await load();
      for (const method of unsafeMethods) {
        if (typeof routeModule[method] !== 'function') continue;
        const handler = routeModule[method] as Handler;
        for (const origin of [undefined, 'https://foreign.test', 'null']) {
          const request = new Request(`${ORIGIN}${path}`, {
            method, headers: origin ? { origin } : {}, body: '{broken json',
          });
          const result = await handler(request, { params: Promise.resolve({}) });
          expect(result.status, `${method} ${path} Origin=${origin}`).toBe(403);
          expect(request.bodyUsed, `${method} ${path}`).toBe(false);
        }
        checked.push(`${method} ${path}`);
      }
    }
    expect(checked).toHaveLength(28);
    expect(checked).toContain('POST /api/auth/otp-verify');
    expect(checked).toContain('POST /api/auth/complete-invite');
    expect(checked).toContain('POST /api/files/upload');
    expect(checked).toContain('POST /api/line/link');
    expect(authenticate).not.toHaveBeenCalled();
    expect(admin).not.toHaveBeenCalled();
    expect(server).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([...internalRoutes])('%sはOriginなしで共有secretを検証し、正しいsecretのみ処理へ進める', async (path) => {
    const routeModule = await moduleLoaders[`../../src/app${path}/route.ts`]();
    const handler = routeModule.POST as Handler;
    const rejectedHeaders: HeadersInit[] = [{}, { 'x-internal-cron-secret': 'wrong' }];
    for (const headers of rejectedHeaders) {
      const response = await handler(new Request(`${ORIGIN}${path}`, { method: 'POST', headers }), { params: Promise.resolve({}) });
      expect(response.status).toBe(401);
    }
    expect(admin).not.toHaveBeenCalled();
    const response = await handler(new Request(`${ORIGIN}${path}`, {
      method: 'POST', headers: { 'x-internal-cron-secret': SECRET },
    }), { params: Promise.resolve({}) });
    // DB入口のテスト用sentinelに到達した証拠。バッチ本体や外部DBは実行しない。
    expect(response.status).toBe(422);
    expect(admin).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('LINE WebhookはOriginなしでも実際のraw body署名を検証する', async () => {
    const routeModule = await moduleLoaders['../../src/app/api/line/webhook/route.ts']();
    const handler = routeModule.POST as Handler;
    const body = '{ "events": [] }';
    const signature = createHmac('sha256', 'unit-only-line-secret').update(body).digest('base64');
    const send = (signature?: string, rawBody = body) => handler(new Request(`${ORIGIN}${webhookPath}`, {
      method: 'POST', body: rawBody, headers: signature ? { 'x-line-signature': signature } : {},
    }), { params: Promise.resolve({}) });
    expect((await send()).status).toBe(401);
    expect((await send('wrong')).status).toBe(401);
    expect((await send(signature, '{"events":[]}')).status).toBe(401);
    expect(admin).not.toHaveBeenCalled();
    admin.mockReturnValue({});
    expect((await send(signature)).status).toBe(200);
    expect(admin).toHaveBeenCalledExactlyOnceWith('line.webhook');
    expect(fetch).not.toHaveBeenCalled();
  });
});
