import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatConnection, type ChatDeps, type SocketLike } from '@/components/chat/chatConnection';
import {
  BACKOFF_SECONDS,
  backoffDelay,
  canRetract,
  dayKeyJst,
  formatDayLabel,
  formatTimeJst,
  knowsCursor,
  latestCursor,
  mergeMessages,
  shouldAutoScroll,
  shouldMarkRead,
  type MessageView,
} from '@/components/chat/chatLogic';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function msg(n: number, patch: Partial<MessageView> = {}): MessageView {
  const createdAt = `2026-11-26T01:00:${String(n).padStart(2, '0')}.000Z`;
  return {
    id: uuid(n),
    caseId: CASE_ID,
    senderUserId: 'other',
    senderName: '相手',
    senderSide: 'staff',
    body: `本文${n}`,
    createdAt,
    retracted: false,
    mine: false,
    cursor: `${createdAt}_${uuid(n)}`,
    ...patch,
  };
}

describe('チャットの純粋ロジック', () => {
  it('再接続の待ちは 1,2,4,8,16,30 秒で頭打ち、±20% のゆらぎ', () => {
    expect(BACKOFF_SECONDS).toEqual([1, 2, 4, 8, 16, 30]);
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((i) => backoffDelay(i, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(5, () => 1)).toBe(36000);
    expect(backoffDelay(-1, mid)).toBe(1000);
  });

  it('merge は id で重複を除き、新しい側で置き換えて時系列に並べる', () => {
    const merged = mergeMessages(
      [msg(3), msg(1)],
      [msg(2), msg(3, { retracted: true, body: null })],
    );
    expect(merged.map((m) => m.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(merged[2].retracted).toBe(true);
    expect(mergeMessages(merged, [msg(1)])).toHaveLength(3);
  });

  it('最新 cursor と既知判定', () => {
    expect(latestCursor([])).toBeUndefined();
    const list = [msg(2), msg(5), msg(3)];
    expect(latestCursor(list)).toBe(msg(5).cursor);
    expect(knowsCursor(list, msg(3).cursor)).toBe(true);
    expect(knowsCursor(list, msg(4).cursor)).toBe(false);
  });

  it('下端付近でだけ自動スクロールする', () => {
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 521, clientHeight: 400 })).toBe(true);
    expect(shouldAutoScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false);
  });

  it('既読は相手の未送信の最新発言があるときだけ', () => {
    expect(shouldMarkRead([], undefined)).toBe(false);
    expect(shouldMarkRead([msg(1, { mine: true })], undefined)).toBe(false);
    expect(shouldMarkRead([msg(1)], undefined)).toBe(true);
    expect(shouldMarkRead([msg(1)], msg(1).cursor)).toBe(false);
    expect(shouldMarkRead([msg(1), msg(2)], msg(1).cursor)).toBe(true);
    expect(shouldMarkRead([msg(1), msg(2, { retracted: true, body: null })], msg(1).cursor)).toBe(
      false,
    );
  });

  it('日付と時刻は日本時間', () => {
    // 2026-11-26T16:30Z は日本では 27 日 01:30
    expect(dayKeyJst('2026-11-26T16:30:00.000Z')).toBe('2026-11-27');
    expect(formatDayLabel('2026-11-26T16:30:00.000Z')).toBe('2026年11月27日');
    expect(formatTimeJst('2026-11-26T16:30:00.000Z')).toBe('01:30');
  });

  it('取り消せるのは自分の未取り消しで時間内のものだけ', () => {
    const now = new Date('2026-11-26T01:10:00.000Z').getTime();
    const mine = msg(0, { mine: true });
    expect(canRetract(mine, 15 * 60_000, now)).toBe(true);
    expect(canRetract(mine, 5 * 60_000, now)).toBe(false);
    expect(canRetract({ ...mine, retracted: true }, 15 * 60_000, now)).toBe(false);
    expect(canRetract({ ...mine, mine: false }, 15 * 60_000, now)).toBe(false);
  });
});

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  signal(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  drop() {
    this.onclose?.();
  }
}

const RETRACT_WINDOW = 15 * 60 * 1000;

class ApiError extends Error {}

describe('ChatConnection', () => {
  let visible = true;
  let sockets: FakeSocket[];
  let server: MessageView[];
  let tickets: 'ok' | 'unavailable' | 'fail';
  let calls: string[];
  let conn: ChatConnection;

  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
  };

  const deps = (): ChatDeps => ({
    random: () => 0.5,
    isVisible: () => visible,
    isUnavailable: (e) => e instanceof ApiError && e.message === 'CHAT_UNAVAILABLE',
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    api: {
      async get<T>(path: string) {
        calls.push(`GET ${path}`);
        const q = new URLSearchParams(path.split('?')[1]);
        const after = q.get('after');
        const before = q.get('before');
        const limit = Number(q.get('limit') ?? 50);
        let items = [...server];
        if (after) items = items.filter((m) => m.cursor > after);
        else if (before) items = items.filter((m) => m.cursor < before).slice(-limit);
        else items = items.slice(-limit);
        const hasMore = after ? items.length > limit : false;
        return { items: after ? items.slice(0, limit) : items, hasMore } as T;
      },
      async post<T>(path: string, body?: unknown) {
        calls.push(`POST ${path}`);
        if (path.endsWith('/ticket')) {
          if (tickets === 'unavailable') throw new ApiError('CHAT_UNAVAILABLE');
          if (tickets === 'fail') throw new ApiError('network');
          return { url: 'ws://chat.test/?ticket=t', expiresIn: 60 } as T;
        }
        const m = msg(server.length + 1, {
          mine: true,
          body: (body as { body: string }).body,
        });
        server.push(m);
        return m as T;
      },
      async del<T>(path: string) {
        calls.push(`DELETE ${path}`);
        return undefined as T;
      },
    },
  });

  const make = (initial: MessageView[] = [], hasOlder = false) => {
    server = [...initial];
    conn = new ChatConnection(
      CASE_ID,
      { messages: initial, hasOlder, retractWindowMs: RETRACT_WINDOW },
      deps(),
    );
    return conn;
  };

  const connectOk = async () => {
    conn.start();
    await flush();
    sockets.at(-1)!.open();
    await flush();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // 既定ではテストの発言はすべて取り消し期間より古い
    vi.setSystemTime(new Date('2026-11-26T03:00:00.000Z'));
    visible = true;
    sockets = [];
    tickets = 'ok';
    calls = [];
  });
  afterEach(() => {
    conn?.stop();
    vi.useRealTimers();
  });

  it('開くとチケットを取って接続し、つながった時点で取りこぼしを取り込む', async () => {
    make([msg(1)]);
    server.push(msg(2));
    await connectOk();
    expect(sockets[0].url).toContain('ticket=');
    expect(conn.getState().connected).toBe(true);
    expect(conn.getState().messages.map((m) => m.id)).toEqual([uuid(1), uuid(2)]);
    expect(calls).toContain(
      `GET /api/cases/${CASE_ID}/messages?after=${encodeURIComponent(msg(1).cursor)}&limit=50`,
    );
  });

  it('新着の合図で after 取得し、既知 cursor の合図では取得しない', async () => {
    make([msg(1)]);
    await connectOk();
    calls.length = 0;
    server.push(msg(2));
    sockets[0].signal({
      type: 'message',
      caseId: CASE_ID,
      cursor: msg(2).cursor,
      senderUserId: 'o',
    });
    await flush();
    expect(conn.getState().messages).toHaveLength(2);
    calls.length = 0;
    sockets[0].signal({
      type: 'message',
      caseId: CASE_ID,
      cursor: msg(2).cursor,
      senderUserId: 'o',
    });
    await flush();
    expect(calls).toEqual([]);
  });

  it('取り消しの合図で直近を取り直し、同じ id を置き換える', async () => {
    vi.setSystemTime(new Date('2026-11-26T01:05:00.000Z'));
    make([msg(1), msg(2)]);
    await connectOk();
    server[1] = msg(2, { retracted: true, body: null });
    sockets[0].signal({
      type: 'retract',
      caseId: CASE_ID,
      cursor: msg(2).cursor,
      senderUserId: 'o',
    });
    await flush();
    expect(conn.getState().messages[1].retracted).toBe(true);
    expect(conn.getState().messages).toHaveLength(2);
  });

  it('25秒ごとに ping を送り、切れたら止める', async () => {
    make();
    await connectOk();
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sockets[0].sent).toEqual(['ping', 'ping']);
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sockets[0].sent).toHaveLength(2);
  });

  it('つながっていた接続が切れたら約1秒後につなぎ直す', async () => {
    make();
    await connectOk();
    sockets[0].drop();
    expect(conn.getState().connected).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(2);
  });

  it('503 CHAT_UNAVAILABLE は定期取得に切り替え、30秒ごとに取りに行く', async () => {
    make([msg(1)]);
    tickets = 'unavailable';
    conn.start();
    await flush();
    expect(conn.getState().degraded).toBe(true);
    expect(sockets).toHaveLength(0);
    calls.length = 0;
    server.push(msg(2));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conn.getState().messages).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(1);
  });

  it('連続5回つなげなければ定期取得に切り替える（待ちは 1,2,4,8 秒）', async () => {
    make();
    tickets = 'fail';
    conn.start();
    await flush();
    for (const sec of [1, 2, 4, 8]) {
      expect(conn.getState().degraded).toBe(false);
      await vi.advanceTimersByTimeAsync(sec * 1000 + 1);
    }
    expect(conn.getState().degraded).toBe(true);
    expect(calls.filter((c) => c.endsWith('/ticket'))).toHaveLength(5);
  });

  it('隠れたら接続を閉じ、見えたら再接続して取りこぼしを埋める', async () => {
    make([msg(1)]);
    await connectOk();
    visible = false;
    conn.onVisibilityChange();
    expect(sockets[0].closed).toBe(true);
    expect(conn.getState().connected).toBe(false);
    server.push(msg(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    visible = true;
    conn.onVisibilityChange();
    await flush();
    sockets[1].open();
    await flush();
    expect(conn.getState().messages).toHaveLength(2);
  });

  it('隠れる前に始めたチケット取得が遅れて返っても、接続は1本だけ', async () => {
    make();
    const gates: (() => void)[] = [];
    const base = deps();
    const post = base.api.post;
    base.api.post = (async (path: string, body?: unknown) => {
      if (path.endsWith('/ticket')) await new Promise<void>((r) => gates.push(r));
      return post(path, body);
    }) as typeof post;
    conn = new ChatConnection(
      CASE_ID,
      { messages: [], hasOlder: false, retractWindowMs: RETRACT_WINDOW },
      base,
    );
    conn.start(); // 試行 A
    await flush();
    visible = false;
    conn.onVisibilityChange();
    visible = true;
    conn.onVisibilityChange(); // 試行 B
    await flush();
    expect(gates).toHaveLength(2);
    gates[0]();
    await flush();
    expect(sockets).toHaveLength(0); // A の応答は捨てる
    gates[1]();
    await flush();
    expect(sockets).toHaveLength(1);
  });

  it('オンラインに戻ったら待たずにつなぎ直す', async () => {
    make();
    tickets = 'fail';
    conn.start();
    await flush();
    tickets = 'ok';
    conn.onOnline();
    await flush();
    expect(sockets).toHaveLength(1);
  });

  it('送信は成功後にだけ反映し、失敗したら何も足さない', async () => {
    make();
    const sent = await conn.send('こんにちは');
    expect(conn.getState().messages.map((m) => m.body)).toEqual(['こんにちは']);
    expect(sent.mine).toBe(true);
    const failing = deps();
    failing.api.post = async () => {
      throw new ApiError('boom');
    };
    const c2 = new ChatConnection(
      CASE_ID,
      { messages: [], hasOlder: false, retractWindowMs: RETRACT_WINDOW },
      failing,
    );
    await expect(c2.send('x')).rejects.toThrow('boom');
    expect(c2.getState().messages).toEqual([]);
  });

  it('自分の投稿を反映しても、それより前に届いた相手の発言を飛ばさずに取り込む', async () => {
    make([msg(1)]);
    await connectOk();
    server.push(msg(2)); // 相手の発言 A（まだ手元に無い）
    await conn.send('自分'); // 自分の発言 B（A より後）
    await conn.catchUp();
    expect(conn.getState().messages.map((m) => m.body)).toEqual(['本文1', '本文2', '自分']);
  });

  it('切断中の取り消しは、再接続の取りこぼし取得で反映される（期間より古い発言は取り直さない）', async () => {
    vi.setSystemTime(new Date('2026-11-26T01:05:00.000Z'));
    const old = msg(1, {
      createdAt: '2026-11-26T00:00:00.000Z',
      cursor: `2026-11-26T00:00:00.000Z_${uuid(1)}`,
    });
    make([old, msg(2)]);
    await connectOk();
    sockets[0].drop();
    server[1] = msg(2, { retracted: true, body: null }); // 切断中に取り消された
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(1100);
    sockets[1].open();
    await flush();
    expect(conn.getState().messages[1].retracted).toBe(true);
    expect(calls.some((c) => c.includes(encodeURIComponent(old.cursor)))).toBe(false);
  });

  it('定期取得でも取り消しが反映される', async () => {
    vi.setSystemTime(new Date('2026-11-26T01:05:00.000Z'));
    make([msg(1), msg(2)]);
    tickets = 'unavailable';
    conn.start();
    await flush();
    server[1] = msg(2, { retracted: true, body: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conn.getState().messages[1].retracted).toBe(true);
  });

  it('取り消し成功後に手元の発言を取り消し表示にする', async () => {
    make([msg(1, { mine: true })]);
    await conn.retract(uuid(1));
    expect(calls).toContain(`DELETE /api/messages/${uuid(1)}`);
    expect(conn.getState().messages[0]).toMatchObject({ retracted: true, body: null });
  });

  it('さらに前を読むと先頭へ足し、hasOlder が更新される', async () => {
    make([msg(3), msg(4)], true);
    server = [msg(1), msg(2), msg(3), msg(4)];
    await conn.loadOlder();
    expect(conn.getState().messages.map((m) => m.id)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect(conn.getState().hasOlder).toBe(false);
  });
});
