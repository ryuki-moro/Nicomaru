import { sendChatSignal, type ChatFetcher } from '@/lib/chat/notify';
import { internalNotifyToken, type ChatSignal } from '@/lib/chat/ticket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ chatService: vi.fn() }));
vi.mock('@/lib/d1/runtime', () => ({ chatService: mocks.chatService }));

const signal: ChatSignal = { type: 'message', caseId: 'c1', cursor: 'k', senderUserId: 'u1' };
const secret = 'test-secret-test-secret-test-secret';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('sendChatSignal', () => {
  it('内部トークン付きで /notify へ合図を送る', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await sendChatSignal(signal, { fetcher: { fetch } satisfies ChatFetcher, secret });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://chat/notify');
    expect(init.method).toBe('POST');
    expect(init.headers['x-chat-internal-token']).toBe(await internalNotifyToken(secret));
    expect(JSON.parse(init.body)).toEqual(signal);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('service binding 未設定なら何もしない', async () => {
    mocks.chatService.mockResolvedValue(undefined);
    await expect(sendChatSignal(signal, { secret })).resolves.toBeUndefined();
  });

  it('秘密値が未設定なら送らない', async () => {
    const fetch = vi.fn();
    vi.stubEnv('CHAT_TICKET_SECRET', '');
    await sendChatSignal(signal, { fetcher: { fetch } });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('通信が失敗しても例外を投げず、本文やIDをログに出さない', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('boom c1 u1'));
    await expect(sendChatSignal(signal, { fetcher: { fetch }, secret })).resolves.toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/c1|u1|boom/);
  });

  it('応答が失敗でも例外を投げない', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    await expect(sendChatSignal(signal, { fetcher: { fetch }, secret })).resolves.toBeUndefined();
  });

  it('応答が返らなければ3秒で打ち切る', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const done = sendChatSignal(signal, { fetcher: { fetch }, secret });
    await vi.advanceTimersByTimeAsync(3001);
    await expect(done).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
