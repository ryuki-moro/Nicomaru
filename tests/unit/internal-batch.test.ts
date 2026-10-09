import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BatchFailure, runBatch } from '@/lib/api/internal';

const PRIVATE_ERROR = 'private@example.test / private-file.pdf';
type Fault = 'database' | 'transport' | 'missing-id';

function fixture(startFault?: Fault, finishFault?: Fault) {
  const writes: { method: string; body: Record<string, unknown>; url: URL }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://batch-fixture.example.test');
    expect(url.pathname).toBe('/rest/v1/batch_runs');
    writes.push({ method: request.method, body: await request.json() as Record<string, unknown>, url });
    const fault = request.method === 'POST' ? startFault : finishFault;
    if (fault === 'transport') throw new TypeError(PRIVATE_ERROR);
    if (fault === 'database') return Response.json({ message: PRIVATE_ERROR, code: 'TEST' }, { status: 400 });
    return Response.json(fault === 'missing-id' ? {} : { id: 'run-id' });
  });
  const admin = createClient('https://batch-fixture.example.test', 'fixture-only-key', {
    auth: { autoRefreshToken: false, persistSession: false }, db: { retry: false }, global: { fetch },
  });
  return { admin, writes };
}

afterEach(() => vi.restoreAllMocks());

describe('runBatchの実行記録', () => {
  it.each<Fault>(['database', 'transport', 'missing-id'])('開始記録が%sで失敗したら処理を開始しない', async (fault) => {
    const f = fixture(fault);
    const operation = vi.fn(async () => ({ targetCount: 10 }));
    await expect(runBatch(f.admin, 'case_purge', operation)).rejects.not.toThrow(PRIVATE_ERROR);
    expect(operation).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
  });

  it('開始と終了を同じ実行IDへ記録し、保存済みの結果を返す', async () => {
    const f = fixture();
    const outcome = { targetCount: 2, detail: { filesRemoved: 3 } };
    expect(await runBatch(f.admin, 'case_purge', async () => outcome)).toBe(outcome);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[0].body).toMatchObject({ job_type: 'case_purge', started_at: expect.any(String) });
    expect(f.writes[1].body).toMatchObject({ http_status: 200, target_count: 2, detail: outcome.detail, finished_at: expect.any(String) });
    expect(f.writes[1].url.searchParams.get('id')).toBe('eq.run-id');
    expect(f.writes[1].url.searchParams.get('select')).toBe('id');
  });

  it.each<Fault>(['database', 'transport', 'missing-id'])('成功後の終了記録が%sなら成功応答せず、別の終了記録で上書きしない', async (fault) => {
    const f = fixture(undefined, fault);
    const operation = vi.fn(async () => ({ targetCount: 2 }));
    await expect(runBatch(f.admin, 'case_purge', operation)).rejects.not.toThrow(PRIVATE_ERROR);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(2);
  });

  it('途中失敗には成功した件数・安全な詳細・HTTP 500を記録する', async () => {
    const f = fixture();
    const outcome = { targetCount: 2, detail: { failedCount: 1, failures: [{ caseId: 'case-3', stage: 'storage' }] } };
    const error = new BatchFailure('案件削除の一部に失敗しました', outcome);
    await expect(runBatch(f.admin, 'case_purge', async () => { throw error; })).rejects.toBe(error);
    expect(f.writes[1].body).toMatchObject({ http_status: 500, target_count: 2, detail: outcome.detail, error_message: error.message });
  });

  it('通常の処理例外もHTTP 500として記録し、元の例外を返す', async () => {
    const f = fixture();
    const error = new Error('fixture failure');
    await expect(runBatch(f.admin, 'case_purge', async () => { throw error; })).rejects.toBe(error);
    expect(f.writes[1].body).toMatchObject({ http_status: 500 });
  });

  it.each<Fault>(['database', 'transport', 'missing-id'])('失敗の終了記録も%sで失敗した場合は元の業務エラーを保ち、記録失敗のPIIを出さない', async (fault) => {
    const f = fixture(undefined, fault);
    const error = new BatchFailure('案件削除の一部に失敗しました', { targetCount: 1, detail: { failedCount: 1 } });
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loggedWarning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(runBatch(f.admin, 'case_purge', async () => { throw error; })).rejects.toBe(error);
    expect(f.writes).toHaveLength(2);
    expect([...loggedError.mock.calls, ...loggedWarning.mock.calls].flat().map(String).join(' ')).not.toContain(PRIVATE_ERROR);
  });
});
