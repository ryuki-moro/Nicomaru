import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { route } from '@/lib/api/route';
import { ApiError } from '@/lib/errors';
import {
  performanceRouteName,
  recordApiPerformance,
  screenPerformanceEvent,
} from '@/lib/observability/performance';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('性能ログに識別可能なデータを残さない', () => {
  it.each([
    [
      '/api/venues/63382846-954f-4bad-b173-82348d8c5b1a?email=secret@example.test',
      '/api/venues/[venueId]',
    ],
    ['/register/private-token#access_token=secret', '/register/[token]'],
    ['/cases/new', '/cases/new'],
    ['/unknown/secret@example.test', 'unknown'],
    [
      '/api/cases/private-case/invitations/private-invite/send',
      '/api/cases/[caseId]/invitations/[invitationId]/send',
    ],
  ])('%s は固定ルート名だけになる', (path, expected) => {
    expect(performanceRouteName(path)).toBe(expected);
  });

  it('全API・画面を静的ルート名として分類でき、新規ルートの計測漏れを検出する', () => {
    const routes: string[] = [];
    const visit = (directory: string, segments: string[]) => {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (file.isDirectory()) {
          visit(
            join(directory, file.name),
            file.name.startsWith('(') ? segments : [...segments, file.name],
          );
        } else if (['route.ts', 'page.tsx'].includes(file.name)) {
          routes.push('/' + segments.join('/'));
        }
      }
    };
    visit('src/app', []);
    for (const path of routes) {
      expect(performanceRouteName(path.replaceAll(/\[[^\]]+\]/g, 'private-id')), path).not.toBe(
        'unknown',
      );
    }
  });

  it('成功レスポンスを変えず開始終了時刻・所要時間・statusを記録する', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    const response = new Response('result', { status: 201 });
    const handler = vi.fn(async () => response);
    expect(await route(handler)(new Request('https://app.test/api/venues'))).toBe(response);
    const logged = JSON.parse(output.mock.calls[0][0]);
    expect(logged).toMatchObject({
      event: 'api_performance',
      route: '/api/venues',
      method: 'GET',
      status: 201,
      failed: false,
    });
    expect(logged.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(logged.finishedAt)).toBeGreaterThanOrEqual(Date.parse(logged.startedAt));
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    new ApiError('FORBIDDEN', 'secret@example.test'),
    new Error('token-private@example.test'),
  ])('例外本文・query・Cookie・本文を性能ログに出さない', async (error) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await route(async () => {
      throw error;
    })(
      new Request(
        'https://app.test/api/venues/63382846-954f-4bad-b173-82348d8c5b1a?email=secret@example.test',
        { headers: { cookie: 'secret-session' } },
      ),
    );
    expect(response.status).toBe(error instanceof ApiError ? 403 : 500);
    const emitted = JSON.stringify([info.mock.calls, errorLog.mock.calls]);
    for (const secret of ['secret@example.test', 'token-private', 'secret-session', '63382846']) {
      expect(emitted).not.toContain(secret);
    }
    expect(JSON.parse(info.mock.calls[0][0]).failed).toBe(true);
  });

  it('不正Originを先に拒否し、その403だけ記録する', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://app.test');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = vi.fn(async () => new Response());
    const request = new Request('https://app.test/api/venues', {
      method: 'POST',
      headers: { origin: 'https://bad.test' },
      body: 'private-body',
    });
    expect((await route(handler)(request)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({ status: 403, failed: true });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private-body');
  });

  it('ログ出力失敗で業務処理を再実行しない', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    expect((await route(handler)(new Request('https://app.test/api/venues'))).status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('任意HTTPメソッドをログ値に使わない', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    recordApiPerformance(
      new Request('https://app.test/api/venues', { method: 'PRIVATE-METHOD' }),
      Date.now(),
      performance.now(),
      405,
    );
    expect(JSON.parse(info.mock.calls[0][0]).method).toBe('OTHER');
  });

  it('画面ログは既知のmetricと固定画面名、有限の値だけを受け入れる', () => {
    expect(
      screenPerformanceEvent(
        '/register/private-token?email=private',
        'LCP',
        1520.1234,
        1_700_000_000_000,
      ),
    ).toMatchObject({ route: '/register/[token]', metric: 'LCP', value: 1520.123, unit: 'ms' });
    expect(screenPerformanceEvent('/mypage', 'CLS', 0.01, 1_700_000_000_000)?.unit).toBe('score');
    expect(screenPerformanceEvent('/mypage', 'private-token', 10, 1_700_000_000_000)).toBeNull();
    for (const value of [NaN, Infinity, -1]) {
      expect(screenPerformanceEvent('/mypage', 'LCP', value, 1_700_000_000_000)).toBeNull();
    }
    expect(screenPerformanceEvent('/mypage', 'LCP', 10, Infinity)).toBeNull();
    expect(screenPerformanceEvent('/mypage', 'LCP', 10, 9e15)).toBeNull();
  });
});
