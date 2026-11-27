import { GET, POST } from '@/app/api/cases/[caseId]/messages/route';
import { POST as READ } from '@/app/api/cases/[caseId]/messages/read/route';
import { POST as TICKET } from '@/app/api/cases/[caseId]/messages/ticket/route';
import { DELETE } from '@/app/api/messages/[messageId]/route';
import { verifyTicket } from '@/lib/chat/ticket';
import { notFound, rateLimited, unauthenticated } from '@/lib/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAppUser: vi.fn(),
  localDB: vi.fn(),
  listMessages: vi.fn(),
  postMessage: vi.fn(),
  retractMessage: vi.fn(),
  markRead: vi.fn(),
  assertCaseAccess: vi.fn(),
  userRateLimit: vi.fn(),
  sendChatSignal: vi.fn(),
  notifyCouples: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ requireAppUser: mocks.requireAppUser }));
vi.mock('@/lib/d1/runtime', () => ({ localDB: mocks.localDB }));
vi.mock('@/lib/d1/messages', () => ({
  listMessages: mocks.listMessages,
  postMessage: mocks.postMessage,
  retractMessage: mocks.retractMessage,
  markRead: mocks.markRead,
  assertCaseAccess: mocks.assertCaseAccess,
}));
vi.mock('@/lib/d1/auth-limits', () => ({ userRateLimit: mocks.userRateLimit }));
vi.mock('@/lib/chat/notify', () => ({ sendChatSignal: mocks.sendChatSignal }));
vi.mock('@/lib/d1/chat-notifications', () => ({
  notifyCouplesOfStaffMessage: mocks.notifyCouples,
}));

const ORIGIN = 'http://127.0.0.1:3104';
const CASE_ID = '11111111-1111-4111-8111-111111111111';
const MSG_ID = '22222222-2222-4222-8222-222222222222';
const staff = { id: 'staff-1', role: 'planner' };
const couple = { id: 'couple-1', role: 'couple' };
const message = { id: MSG_ID, caseId: CASE_ID, cursor: 'cursor-1', body: 'こんにちは' };
const ctx = { params: Promise.resolve({ caseId: CASE_ID }) };
const db = {};

const post = (url: string, body?: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const base = `${ORIGIN}/api/cases/${CASE_ID}/messages`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_BASE_URL', ORIGIN);
  vi.stubEnv('CHAT_WS_URL', '');
  vi.stubEnv('CHAT_TICKET_SECRET', '');
  mocks.requireAppUser.mockResolvedValue(staff);
  mocks.localDB.mockResolvedValue(db);
  mocks.postMessage.mockResolvedValue(message);
  mocks.listMessages.mockResolvedValue({ items: [], hasMore: false });
});

describe('GET /messages', () => {
  it('limit の既定は50で、結果をそのまま返す', async () => {
    const r = await GET(new Request(base), ctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [], hasMore: false });
    expect(mocks.listMessages).toHaveBeenCalledWith(db, staff, CASE_ID, {
      limit: 50,
      after: undefined,
      before: undefined,
    });
  });
  it.each(['0', '51', 'abc', '1.5', '-1'])('limit=%s は丸めず 400', async (limit) => {
    const r = await GET(new Request(`${base}?limit=${limit}`), ctx);
    expect(r.status).toBe(400);
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });
  it('after / before を D1 層へ渡す', async () => {
    await GET(new Request(`${base}?after=x&limit=5`), ctx);
    expect(mocks.listMessages).toHaveBeenCalledWith(db, staff, CASE_ID, {
      limit: 5,
      after: 'x',
      before: undefined,
    });
  });
  it('UUID でなければ 404', async () => {
    const r = await GET(new Request(base), { params: Promise.resolve({ caseId: 'nope' }) });
    expect(r.status).toBe(404);
  });
});

describe('POST /messages', () => {
  it('担当者の投稿は 201。合図と新郎新婦への通知を送る', async () => {
    const r = await POST(post(base, { body: '  こんにちは  ' }), ctx);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual(message);
    expect(mocks.postMessage).toHaveBeenCalledWith(db, staff, CASE_ID, 'こんにちは', []);
    expect(mocks.userRateLimit).toHaveBeenCalledWith(db, 'chat_post', staff.id, {
      windowSeconds: 60,
      max: 20,
    });
    expect(mocks.sendChatSignal).toHaveBeenCalledWith({
      type: 'message',
      caseId: CASE_ID,
      cursor: 'cursor-1',
      senderUserId: staff.id,
    });
    expect(mocks.notifyCouples).toHaveBeenCalledWith(db, staff, CASE_ID);
  });
  it('新郎新婦の投稿は合図だけで通知は作らない', async () => {
    mocks.requireAppUser.mockResolvedValue(couple);
    const r = await POST(post(base, { body: 'はい' }), ctx);
    expect(r.status).toBe(201);
    expect(mocks.sendChatSignal).toHaveBeenCalledOnce();
    expect(mocks.notifyCouples).not.toHaveBeenCalled();
  });
  it('通知の作成に失敗しても 201', async () => {
    mocks.notifyCouples.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await POST(post(base, { body: 'x' }), ctx);
    expect(r.status).toBe(201);
  });
  it.each([{ body: '' }, { body: '   ' }, { body: 'あ'.repeat(1001) }, {}, { body: 1 }])(
    '本文が不正なら 400 (%j)',
    async (payload) => {
      const r = await POST(post(base, payload), ctx);
      expect(r.status).toBe(400);
      expect(mocks.postMessage).not.toHaveBeenCalled();
    },
  );
  it('JSON でなければ 400', async () => {
    expect((await POST(post(base), ctx)).status).toBe(400);
  });
  it('未ログインは 401', async () => {
    mocks.requireAppUser.mockRejectedValue(unauthenticated());
    expect((await POST(post(base, { body: 'x' }), ctx)).status).toBe(401);
  });
  it('UUID でなければ 404', async () => {
    const r = await POST(post(base, { body: 'x' }), { params: Promise.resolve({ caseId: 'z' }) });
    expect(r.status).toBe(404);
  });
  it('レート制限なら 429 で投稿しない', async () => {
    mocks.userRateLimit.mockRejectedValue(rateLimited());
    const r = await POST(post(base, { body: 'x' }), ctx);
    expect(r.status).toBe(429);
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.sendChatSignal).not.toHaveBeenCalled();
  });
  it('同一Origin以外は 403', async () => {
    const r = await POST(
      new Request(base, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'x' }),
      }),
      ctx,
    );
    expect(r.status).toBe(403);
  });
});

describe('POST /messages/read', () => {
  it('204 を返す', async () => {
    const r = await READ(post(`${base}/read`, { cursor: 'cursor-1' }), ctx);
    expect(r.status).toBe(204);
    expect(mocks.markRead).toHaveBeenCalledWith(db, staff, CASE_ID, 'cursor-1');
  });
  it('cursor が無ければ 400', async () => {
    expect((await READ(post(`${base}/read`, {}), ctx)).status).toBe(400);
  });
  it('案件に入れなければ 404', async () => {
    mocks.markRead.mockRejectedValue(notFound());
    expect((await READ(post(`${base}/read`, { cursor: 'c' }), ctx)).status).toBe(404);
  });
});

describe('POST /messages/ticket', () => {
  const url = `${base}/ticket`;
  it('接続先か秘密値が未設定なら 503 CHAT_UNAVAILABLE', async () => {
    const r = await TICKET(post(url), ctx);
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe('CHAT_UNAVAILABLE');
    vi.stubEnv('CHAT_WS_URL', 'ws://127.0.0.1:8794/ws');
    expect((await TICKET(post(url), ctx)).status).toBe(503);
  });
  it('構成済みなら検証可能なチケット付きURLを返す', async () => {
    const secret = 'ticket-secret-ticket-secret-ticket-secret';
    vi.stubEnv('CHAT_WS_URL', 'ws://127.0.0.1:8794/ws');
    vi.stubEnv('CHAT_TICKET_SECRET', secret);
    const r = await TICKET(post(url), ctx);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.expiresIn).toBe(60);
    const parsed = new URL(body.url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('ws://127.0.0.1:8794/ws');
    const claims = await verifyTicket(secret, parsed.searchParams.get('ticket') ?? '');
    expect(claims).toMatchObject({ caseId: CASE_ID, userId: staff.id });
  });
  it('案件に入れなければ未構成でも 404（存在を漏らさない）', async () => {
    mocks.assertCaseAccess.mockRejectedValue(notFound());
    expect((await TICKET(post(url), ctx)).status).toBe(404);
  });
});

describe('DELETE /messages/{id}', () => {
  const del = (id = MSG_ID) =>
    DELETE(
      new Request(`${ORIGIN}/api/messages/${id}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN },
      }),
      { params: Promise.resolve({ messageId: id }) },
    );
  it('取り消して retract の合図を送る', async () => {
    mocks.retractMessage.mockResolvedValue({ caseId: CASE_ID, cursor: 'cursor-1' });
    const r = await del();
    expect(r.status).toBe(200);
    expect(mocks.sendChatSignal).toHaveBeenCalledWith({
      type: 'retract',
      caseId: CASE_ID,
      cursor: 'cursor-1',
      senderUserId: staff.id,
    });
  });
  it('取り消せなければ合図を送らない', async () => {
    mocks.retractMessage.mockRejectedValue(notFound());
    expect((await del()).status).toBe(404);
    expect(mocks.sendChatSignal).not.toHaveBeenCalled();
  });
  it('UUID でなければ 404', async () => {
    expect((await del('x')).status).toBe(404);
  });
});
