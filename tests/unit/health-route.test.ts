import { GET } from '@/app/api/health/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: vi.fn(), prepare: vi.fn(), first: vi.fn() }));
vi.mock('@/lib/d1/runtime', () => ({ localDB: mocks.db }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.mockResolvedValue({ prepare: mocks.prepare });
  mocks.prepare.mockReturnValue({ first: mocks.first });
  mocks.first.mockResolvedValue({ ok: 1 });
});
describe('D1接続の死活確認', () => {
  it('業務データを取得せずSELECT 1だけを実行する', async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith('SELECT 1 AS ok');
  });
  it.each([null, {}, { ok: 0 }])('応答が不完全なら503 (%j)', async (row) => {
    mocks.first.mockResolvedValue(row);
    const r = await GET();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false });
  });
  it.each(['DB unavailable', 'permission denied', 'schema failure', 'private network detail'])(
    'DB障害の詳細を返さない (%s)',
    async (message) => {
      mocks.first.mockRejectedValue(new Error(message));
      const r = await GET();
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false });
    },
  );
  it('接続設定不足を成功扱いしない', async () => {
    mocks.db.mockRejectedValue(new Error('missing secret'));
    expect((await GET()).status).toBe(503);
  });
});
