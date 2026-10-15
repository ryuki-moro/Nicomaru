import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  cleanupPerformanceFixture,
  type PerformanceFixtureIds,
} from '../e2e/helpers/performance-cleanup';

function fixture(): PerformanceFixtureIds {
  return {
    caseIds: Array.from({ length: 300 }, () => randomUUID()),
    profileIds: Array.from({ length: 30 }, () => randomUUID()),
    authUserIds: Array.from({ length: 30 }, () => randomUUID()),
    venueIds: Array.from({ length: 3 }, () => randomUUID()),
  };
}

function client(fetch: typeof globalThis.fetch) {
  return createClient('http://127.0.0.1:54321', 'fixture-service-key', {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
}

describe('性能fixtureの後片付け', () => {
  it('300件の一括DELETEが414になるgatewayでも専用IDだけを短いURLで全削除する', async () => {
    const ids = fixture();
    const calls: URL[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(init?.method).toBe('DELETE');
      const url = new URL(String(input));
      calls.push(url);
      if (url.href.length > 8192) return new Response('URI Too Long', { status: 414 });
      return url.pathname.startsWith('/auth/')
        ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(null, { status: 204 });
    });
    const admin = client(fetch);
    expect((await admin.from('wedding_cases').delete().in('id', ids.caseIds)).status).toBe(414);
    expect(calls[0].href.length).toBeGreaterThan(8192);
    calls.length = 0;

    expect(await cleanupPerformanceFixture(admin, ids)).toEqual([]);
    expect(calls.every((url) => url.href.length < 4096)).toBe(true);
    const caseCalls = calls.filter((url) => url.pathname === '/rest/v1/wedding_cases');
    expect(caseCalls).toHaveLength(6);
    const sentIds = caseCalls.flatMap((url) => url.searchParams.get('id')!.slice(4, -1).split(','));
    expect(sentIds).toEqual(ids.caseIds);
    expect(new Set(sentIds).size).toBe(300);
    // FK参照元を先に消し、Auth削除がプロフィール削除より先行しない。
    const paths = calls.map((url) => url.pathname);
    expect(paths.slice(0, 6)).toEqual(Array(6).fill('/rest/v1/wedding_cases'));
    expect(paths[6]).toBe('/rest/v1/audit_logs');
    expect(paths[7]).toBe('/rest/v1/user_profiles');
    expect(paths.slice(8, -1)).toEqual(ids.authUserIds.map((id) => `/auth/v1/admin/users/${id}`));
    expect(paths.at(-1)).toBe('/rest/v1/venues');
  });

  it('DB失敗は本文やIDを出さず記録し、残りの専用fixtureの清掃も試みる', async () => {
    const ids = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).includes('/rest/v1/wedding_cases'))
        return new Response(
          JSON.stringify({
            code: '23503',
            message: `private-email@example.test ${ids.caseIds[0]}`,
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      return String(input).includes('/auth/')
        ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(null, { status: 204 });
    });
    const failures = await cleanupPerformanceFixture(client(fetch), ids);
    expect(failures).toEqual(Array(6).fill({ step: 'cases', status: 409, code: '23503' }));
    expect(JSON.stringify(failures)).not.toContain('private-email');
    expect(JSON.stringify(failures)).not.toContain(ids.caseIds[0]);
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain('/rest/v1/venues');
  });

  it('未作成のfixtureでは削除リクエストを送らない', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await cleanupPerformanceFixture(client(fetch), {
        caseIds: [],
        profileIds: [],
        authUserIds: [],
        venueIds: [],
      }),
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
