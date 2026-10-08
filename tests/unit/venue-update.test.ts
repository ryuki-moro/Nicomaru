import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PATCH } from '@/app/api/venues/[venueId]/route';
import { forbidden, unauthenticated } from '@/lib/errors';

const { requireRole, createServerClient } = vi.hoisted(() => ({
  requireRole: vi.fn(), createServerClient: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ requireRole }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: createServerClient }));

const VENUE_ID = '11111111-1111-4111-8111-111111111111';
const original = {
  id: VENUE_ID, name: '変更前の式場', code: 'DEMO01', contact_email: 'old@example.test',
  active: true, updated_at: '2026-10-08T00:00:00Z',
};

beforeEach(() => {
  vi.stubEnv('APP_BASE_URL', undefined);
  requireRole.mockReset().mockResolvedValue({ role: 'system_admin' });
  createServerClient.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function request(body: unknown, origin: string | null = 'http://app.test') {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin !== null) headers.set('origin', origin);
  return new Request(`http://app.test/api/venues/${VENUE_ID}`, {
    method: 'PATCH', headers, body: JSON.stringify(body),
  });
}
const context = (venueId = VENUE_ID) => ({ params: Promise.resolve({ venueId }) });

/** 実Supabase SDKにHTTP応答を渡し、送信先・更新範囲・RPC内容を検証する。 */
function databaseMock(options: {
  missing?: boolean;
  updateError?: { code: string; status: number };
  auditError?: boolean;
  beforeAudit?: () => Promise<void>;
} = {}) {
  const requests: { url: URL; method: string; body: Record<string, unknown> }[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    const url = new URL(outgoing.url);
    const body = await outgoing.json() as Record<string, unknown>;
    requests.push({ url, method: outgoing.method, body });
    if (url.pathname === '/rest/v1/venues') {
      if (options.updateError) return Response.json({
        code: options.updateError.code, message: 'test database error',
      }, { status: options.updateError.status });
      return Response.json(options.missing ? [] : [{ ...original, ...body }]);
    }
    if (url.pathname === '/rest/v1/rpc/log_audit') {
      await options.beforeAudit?.();
      return options.auditError
        ? Response.json({ code: 'XX000', message: 'audit unavailable' }, { status: 500 })
        : Response.json(null);
    }
    throw new Error(`予期しないDBリクエスト: ${url.pathname}`);
  };
  const client = createClient('http://supabase.test', 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchMock },
  });
  createServerClient.mockResolvedValue(client);
  return requests;
}

describe('式場更新API', () => {
  it('system_adminが指定式場だけを更新し、個人情報の値を監査ログへ複製しない', async () => {
    const requests = databaseMock();
    const response = await PATCH(request({
      name: '  新しい式場  ', contactEmail: '  CONTACT@EXAMPLE.TEST ', active: false,
    }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: VENUE_ID, name: '新しい式場', code: 'DEMO01', contactEmail: 'contact@example.test',
      active: false, updatedAt: original.updated_at,
    });
    expect(requireRole).toHaveBeenCalledWith('system_admin');
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe('PATCH');
    expect(requests[0].url.searchParams.get('id')).toBe(`eq.${VENUE_ID}`);
    expect(requests[0].body).toEqual({
      name: '新しい式場', contact_email: 'contact@example.test', active: false,
    });
    expect(requests[1].method).toBe('POST');
    expect(requests[1].body).toEqual({
      p_action: 'venue.update', p_target_type: 'venues', p_target_id: VENUE_ID,
      p_detail: { changed: ['name', 'contact_email', 'active'] },
    });
  });

  it('メールだけをnullで消去し、未指定の式場名・コード・利用状態を維持する', async () => {
    const requests = databaseMock();
    const response = await PATCH(request({ contactEmail: null }), context());
    expect(response.status).toBe(200);
    expect(requests[0].body).toEqual({ contact_email: null });
    expect(await response.json()).toMatchObject({
      name: original.name, code: original.code, contactEmail: null, active: original.active,
    });
  });

  it.each([
    {}, { name: ' ' }, { name: 'あ'.repeat(101) }, { name: null },
    { contactEmail: 'invalid' }, { contactEmail: '' }, { active: 'false' },
    { code: 'NEWCODE' }, { name: '許可値', code: 'NEWCODE' },
    { adminEmail: 'other@example.test' }, { role: 'system_admin' }, { id: VENUE_ID },
  ])('不正または編集対象外の入力%jは書き込み前に400', async (body) => {
    const response = await PATCH(request(body), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('壊れたJSONは書き込み前に400', async () => {
    const req = new Request(`http://app.test/api/venues/${VENUE_ID}`, {
      method: 'PATCH', headers: { origin: 'http://app.test' }, body: '{',
    });
    expect((await PATCH(req, context())).status).toBe(400);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it.each([
    null, 'null', 'invalid', 'https://foreign.test', 'https://app.test', 'http://app.test:1234',
    'http://app.test/', 'http://app.test/path', 'http://user@app.test',
    'http://app.test http://foreign.test', 'file://app.test', 'http://app.test#fragment',
  ])('不正なOrigin(%s)は書き込み前に403', async (origin) => {
    const response = await PATCH(request({ name: '更新' }, origin), context());
    expect(response.status).toBe(403);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('request.urlがlocalhostへ正規化されても、設定済み127.0.0.1のOriginを許可する', async () => {
    vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3000');
    databaseMock();
    const req = new Request(`http://localhost:3000/api/venues/${VENUE_ID}`, {
      method: 'PATCH', headers: { origin: 'http://127.0.0.1:3000' },
      body: JSON.stringify({ active: false }),
    });
    expect((await PATCH(req, context())).status).toBe(200);
  });

  it.each([
    'http://localhost:3000', 'https://127.0.0.1:3000',
    'http://127.0.0.1:3001', 'http://foreign.test:3000',
  ])('APP_BASE_URLとhost/scheme/portが異なるOrigin(%s)は拒否する', async (origin) => {
    vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3000');
    // request.url自体が一致しても、設定した公開Originより優先させない。
    const req = new Request(`${origin}/api/venues/${VENUE_ID}`, {
      method: 'PATCH', headers: { origin }, body: JSON.stringify({ active: false }),
    });
    expect((await PATCH(req, context())).status).toBe(403);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('Hostや転送ヘッダーで許可Originを差し替えられない', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://trusted.test');
    const req = new Request(`http://localhost:3000/api/venues/${VENUE_ID}`, {
      method: 'PATCH', headers: {
        origin: 'https://foreign.test', host: 'foreign.test',
        'x-forwarded-host': 'foreign.test', 'x-forwarded-proto': 'https',
      }, body: JSON.stringify({ active: false }),
    });
    expect((await PATCH(req, context())).status).toBe(403);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it.each([
    '', 'invalid', 'null', '/relative', 'ftp://app.test', 'file://app.test',
    'https://user:password@app.test', 'https://app.test:invalid',
  ])('APP_BASE_URLの不正設定(%s)でrequest.urlへフォールバックしない', async (baseUrl) => {
    vi.stubEnv('APP_BASE_URL', baseUrl);
    expect((await PATCH(request({ active: false }), context())).status).toBe(403);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it.each([
    [unauthenticated(), 401], [forbidden(), 403],
  ])('権限違反は入力検証・更新前に返す (%s)', async (error, status) => {
    requireRole.mockRejectedValueOnce(error);
    expect((await PATCH(request({ name: '' }), context())).status).toBe(status);
    expect(requireRole).toHaveBeenCalledWith('system_admin');
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('UUID不正はDB問い合わせ前に404', async () => {
    const response = await PATCH(request({ active: false }), context('invalid-id'));
    expect(response.status).toBe(404);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('更新された行がなければ404として監査を記録しない', async () => {
    const requests = databaseMock({ missing: true });
    expect((await PATCH(request({ active: false }), context())).status).toBe(404);
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['42501', 403], ['23505', 409], ['23514', 400], ['22P02', 404], ['XX000', 500],
  ])('DBエラー%sを%dに写像し、監査を記録しない', async (code, status) => {
    const requests = databaseMock({ updateError: { code, status: 400 } });
    expect((await PATCH(request({ active: false }), context())).status).toBe(status);
    expect(requests).toHaveLength(1);
  });

  it('監査の完了を待ってから成功を返す', async () => {
    let releaseAudit!: () => void;
    let announceAudit!: () => void;
    const started = new Promise<void>((resolve) => { announceAudit = resolve; });
    const gate = new Promise<void>((resolve) => { releaseAudit = resolve; });
    databaseMock({ beforeAudit: async () => { announceAudit(); await gate; } });
    let settled = false;
    const pending = PATCH(request({ name: '更新' }), context()).then((response) => {
      settled = true;
      return response;
    });
    await started;
    expect(settled).toBe(false);
    releaseAudit();
    expect((await pending).status).toBe(200);
  });

  it('更新後に監査が失敗しても成功を返し、診断ログを残す', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    databaseMock({ auditError: true });
    expect((await PATCH(request({ active: false }), context())).status).toBe(200);
    expect(log).toHaveBeenCalledWith(
      '[api] 式場更新の監査ログを記録できませんでした', expect.objectContaining({ code: 'XX000' }),
    );
  });
});
