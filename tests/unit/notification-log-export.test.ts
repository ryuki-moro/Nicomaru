import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/system/notification-logs.csv/route';
import { ApiError, forbidden, unauthenticated } from '@/lib/errors';
import {
  loadNotificationLogsForExport,
  type NotificationLogExportRow,
} from '@/lib/services/notification-log-export';

const { requireRole, createServerClient } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createServerClient: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ requireRole }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: createServerClient }));

beforeEach(() => {
  requireRole.mockReset().mockResolvedValue({ role: 'system_admin' });
  createServerClient.mockReset();
});

function makeRows(count: number, time = '2026-10-06T00:00:00.123456+00:00') {
  return Array.from({ length: count }, (_, index): NotificationLogExportRow => ({
    id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    provider: 'email',
    status: 'success',
    provider_message_id: `message-${index + 1}`,
    created_at: time,
    notifications: {
      notification_type: 'info',
      venues: { name: 'テスト式場' },
      wedding_cases: { case_code: 'TEST-2026-0001' },
    },
  }));
}

/** JS Dateだけでは比較できないマイクロ秒も、DBと同じ順序で比較する。 */
function micros(value: string): bigint {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`テスト日時を解釈できません: ${value}`);
  return (
    BigInt(Date.parse(`${match[1]}${match[3]}`)) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'))
  );
}

function databaseMock(
  initial: NotificationLogExportRow[],
  options: {
    cap?: number;
    failAt?: number;
    beforeRead?: (requestNumber: number, rows: NotificationLogExportRow[]) => void;
  } = {},
) {
  const store = [...initial];
  const requests: URL[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    requests.push(url);
    if (requests.length === options.failAt) {
      return new Response(JSON.stringify({ code: 'XX000', message: '途中のDB障害' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    options.beforeRead?.(requests.length, store);
    let rows = [...store];
    for (const filter of url.searchParams.getAll('created_at')) {
      const separator = filter.indexOf('.');
      const operator = filter.slice(0, separator);
      const boundary = micros(filter.slice(separator + 1));
      rows = rows.filter((row) =>
        operator === 'gte' ? micros(row.created_at) >= boundary : micros(row.created_at) < boundary,
      );
    }
    const cursorFilter = url.searchParams.get('or');
    if (cursorFilter) {
      // 実SDKが送るquoted PostgREST条件を読む。URLエンコードもSDK経由で検証する。
      const match =
        /^\(created_at\.lt\.("(?:[^"\\]|\\.)*"),and\(created_at\.eq\.("(?:[^"\\]|\\.)*"),id\.lt\.("(?:[^"\\]|\\.)*")\)\)$/.exec(
          cursorFilter,
        );
      if (!match) throw new Error(`カーソル条件が不正です: ${cursorFilter}`);
      const time = JSON.parse(match[1]) as string;
      expect(JSON.parse(match[2])).toBe(time);
      const id = JSON.parse(match[3]) as string;
      rows = rows.filter(
        (row) =>
          micros(row.created_at) < micros(time) ||
          (micros(row.created_at) === micros(time) && row.id < id),
      );
    }
    rows.sort((a, b) =>
      micros(a.created_at) === micros(b.created_at)
        ? b.id.localeCompare(a.id)
        : micros(a.created_at) > micros(b.created_at)
          ? -1
          : 1,
    );
    const limit = Number(url.searchParams.get('limit'));
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(1000);
    expect(url.searchParams.get('order')).toBe('created_at.desc,id.desc');
    expect(url.searchParams.has('offset')).toBe(false);
    return new Response(JSON.stringify(rows.slice(0, Math.min(options.cap ?? 1000, limit))), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createClient('http://supabase.test', 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchMock },
  });
  createServerClient.mockResolvedValue(client);
  return { client, requests };
}

const request = (query = '') =>
  new Request(`http://app.test/api/system/notification-logs.csv${query}`);

describe('通知ログCSVの分割取得', () => {
  it('同時刻の1,001行を上限1,000件のAPIから重複なく全件読む', async () => {
    const { client, requests } = databaseMock(makeRows(1001));
    const rows = await loadNotificationLogsForExport(client);
    expect(rows).toHaveLength(1001);
    expect(new Set(rows.map((row) => row.id)).size).toBe(1001);
    expect(rows[0].provider_message_id).toBe('message-1001');
    expect(rows[1000].provider_message_id).toBe('message-1');
    expect(requests).toHaveLength(3);
  });

  it('1,000件より低いサーバー上限でも短いページで終了しない', async () => {
    const { client, requests } = databaseMock(makeRows(1001), { cap: 250 });
    expect(await loadNotificationLogsForExport(client)).toHaveLength(1001);
    expect(requests).toHaveLength(6);
  });

  it('DBカーソルのマイクロ秒を丸めず、同じミリ秒内の後続行を読む', async () => {
    const rows = makeRows(1500);
    for (const row of rows.slice(0, 500)) row.created_at = '2026-10-06T00:00:00.123455+00:00';
    const { client, requests } = databaseMock(rows);
    expect(await loadNotificationLogsForExport(client)).toHaveLength(1500);
    expect(requests[1].searchParams.get('or')).toContain('00:00:00.123456+00:00');
  });

  it('取得途中の先頭への新規追加で既存行を重複・欠落させない', async () => {
    const initial = makeRows(1500);
    const { client } = databaseMock(initial, {
      beforeRead(number, rows) {
        if (number === 2)
          rows.push({
            ...makeRows(1, '2026-10-06T00:00:01+00:00')[0],
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            provider_message_id: 'new-head',
          });
      },
    });
    const rows = await loadNotificationLogsForExport(client);
    expect(rows).toHaveLength(1500);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(initial.map((row) => row.id)));
  });

  it('カーソルの引用符・バックスラッシュを生のor条件へ混入させない', async () => {
    const row = makeRows(1)[0];
    row.id = 'value\\",or(id.gt.0)';
    const { client, requests } = databaseMock([row], { failAt: 2 });
    await expect(loadNotificationLogsForExport(client)).rejects.toBeInstanceOf(ApiError);
    expect(requests[1].searchParams.get('or')).toBe(
      `(created_at.lt.${JSON.stringify(row.created_at)},and(created_at.eq.${JSON.stringify(row.created_at)},id.lt.${JSON.stringify(row.id)}))`,
    );
  });
});

describe('通知ログCSV API', () => {
  it.each([0, 10000, 10001, 12000])('%i件を最大10,000件と正しい超過フラグで返す', async (count) => {
    const { requests } = databaseMock(makeRows(count));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-truncated')).toBe(String(count > 10000));
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toContain('notification-logs.csv');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv.split('\r\n').length - 2).toBe(Math.min(count, 10000));
    expect(requests.length).toBe(count === 0 ? 1 : 11);
    if (count > 10000) expect(requests[10].searchParams.get('limit')).toBe('1');
  });

  it('同日指定はJSTの開始以上・翌日開始未満を出力する', async () => {
    const rows = makeRows(4);
    [
      '2026-10-05T14:59:59.999999Z',
      '2026-10-05T15:00:00Z',
      '2026-10-06T14:59:59.999999Z',
      '2026-10-06T15:00:00Z',
    ].forEach((time, index) => {
      rows[index].created_at = time;
    });
    const { requests } = databaseMock(rows);
    const response = await GET(request('?from=2026-10-06&to=2026-10-06'));
    const csv = await response.text();
    expect(response.status).toBe(200);
    expect(csv).toContain('message-2');
    expect(csv).toContain('message-3');
    expect(csv).not.toContain('message-1');
    expect(csv).not.toContain('message-4');
    for (const url of requests)
      expect(url.searchParams.getAll('created_at')).toEqual([
        'gte.2026-10-06T00:00:00+09:00',
        'lt.2026-10-07T00:00:00+09:00',
      ]);
  });

  it.each([
    ['?from=2026-02-30', 'from'],
    ['?to=0000-01-01', 'to'],
    ['?from=2026-10-07&to=2026-10-06', 'to'],
    ['?from=2026-10-06&from=2026-10-06', 'from'],
  ])('不正な期間%sはDB取得前に項目別400', async (query, field) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field })]),
    );
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it.each([
    [unauthenticated(), 401],
    [forbidden(), 403],
  ])('権限エラーは期間検証とDB取得より先に返す (%s)', async (error, status) => {
    requireRole.mockRejectedValueOnce(error);
    const response = await GET(request('?from=invalid'));
    expect(response.status).toBe(status);
    expect(requireRole).toHaveBeenCalledWith('system_admin');
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('途中のDB障害は部分CSVを返さず失敗する', async () => {
    databaseMock(makeRows(1500), { failAt: 2 });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.has('x-truncated')).toBe(false);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('取得列とCSVは個人情報・内部カーソルを含めず、数式をエスケープする', async () => {
    const row = makeRows(1)[0];
    const fixture = {
      ...row,
      response_json: { secret: '秘密の応答' },
      notifications: {
        ...row.notifications!,
        body: '秘密の本文',
        full_name: '秘密の氏名',
        venues: { name: '=HYPERLINK("evil")' },
      },
    };
    const { requests } = databaseMock([fixture]);
    const response = await GET(request());
    const csv = await response.text();
    expect(csv).not.toContain('秘密');
    expect(csv).not.toContain(row.id);
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
    for (const url of requests) {
      const select = url.searchParams.get('select');
      expect(select).not.toMatch(/body|full_name|response_json/);
    }
    expect(requireRole).toHaveBeenCalledWith('system_admin');
  });
});
