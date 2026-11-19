import type { D1Database } from '@cloudflare/workers-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BatchFailure, runBatchD1 as runBatch } from '@/lib/d1/batches';

const PRIVATE_ERROR = 'private@example.test / private-file.pdf';
type Fault = 'database' | 'transport' | 'missing-id';

function fixture(startFault?: Fault, finishFault?: Fault) {
  const writes: { method: string; body: Record<string, unknown>; url: URL }[] = [];
  const admin = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const start = sql.startsWith('INSERT');
          const id = String(start ? args[0] : args[5]);
          const url = new URL('https://batch-fixture.example.test');
          url.searchParams.set('id', `eq.${id}`);
          url.searchParams.set('select', 'id');
          writes.push({
            method: start ? 'POST' : 'PATCH',
            url,
            body: start
              ? { job_type: args[1], started_at: args[2] }
              : {
                  finished_at: args[0],
                  target_count: args[1],
                  http_status: args[2],
                  detail: JSON.parse(String(args[3])),
                  error_message: args[4],
                },
          });
          const fault = start ? startFault : finishFault;
          if (fault === 'database' || fault === 'transport') throw new Error(PRIVATE_ERROR);
          return fault === 'missing-id' ? null : { id };
        },
      }),
    }),
  } as unknown as D1Database;
  return { admin, writes };
}

afterEach(() => vi.restoreAllMocks());

describe('runBatchの実行記録', () => {
  it.each<Fault>(['database', 'transport', 'missing-id'])(
    '開始記録が%sで失敗したら処理を開始しない',
    async (fault) => {
      const f = fixture(fault);
      const operation = vi.fn(async () => ({ targetCount: 10 }));
      await expect(runBatch(f.admin, 'case_purge', operation)).rejects.not.toThrow(PRIVATE_ERROR);
      expect(operation).not.toHaveBeenCalled();
      expect(f.writes).toHaveLength(1);
    },
  );

  it('開始と終了を同じ実行IDへ記録し、保存済みの結果を返す', async () => {
    const f = fixture();
    const outcome = { targetCount: 2, detail: { filesRemoved: 3 } };
    expect(await runBatch(f.admin, 'case_purge', async () => outcome)).toBe(outcome);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[0].body).toMatchObject({
      job_type: 'case_purge',
      started_at: expect.any(String),
    });
    expect(f.writes[1].body).toMatchObject({
      http_status: 200,
      target_count: 2,
      detail: outcome.detail,
      finished_at: expect.any(String),
    });
    expect(f.writes[1].url.searchParams.get('id')).toBe(
      `eq.${f.writes[0].url.searchParams.get('id')?.slice(3)}`,
    );
    expect(f.writes[1].url.searchParams.get('select')).toBe('id');
  });

  it.each<Fault>(['database', 'transport', 'missing-id'])(
    '成功後の終了記録が%sなら成功応答せず、別の終了記録で上書きしない',
    async (fault) => {
      const f = fixture(undefined, fault);
      const operation = vi.fn(async () => ({ targetCount: 2 }));
      await expect(runBatch(f.admin, 'case_purge', operation)).rejects.not.toThrow(PRIVATE_ERROR);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveLength(2);
    },
  );

  it('途中失敗には成功した件数・安全な詳細・HTTP 500を記録する', async () => {
    const f = fixture();
    const outcome = {
      targetCount: 2,
      detail: { failedCount: 1, failures: [{ caseId: 'case-3', stage: 'storage' }] },
    };
    const error = new BatchFailure('案件削除の一部に失敗しました', outcome);
    await expect(
      runBatch(f.admin, 'case_purge', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.writes[1].body).toMatchObject({
      http_status: 500,
      target_count: 2,
      detail: outcome.detail,
      error_message: error.message,
    });
  });

  it('通常の処理例外もHTTP 500として記録し、元の例外を返す', async () => {
    const f = fixture();
    const error = new Error('fixture failure');
    await expect(
      runBatch(f.admin, 'case_purge', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.writes[1].body).toMatchObject({ http_status: 500 });
  });

  it.each<Fault>(['database', 'transport', 'missing-id'])(
    '失敗の終了記録も%sで失敗した場合は元の業務エラーを保ち、記録失敗のPIIを出さない',
    async (fault) => {
      const f = fixture(undefined, fault);
      const error = new BatchFailure('案件削除の一部に失敗しました', {
        targetCount: 1,
        detail: { failedCount: 1 },
      });
      const loggedError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const loggedWarning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(
        runBatch(f.admin, 'case_purge', async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(f.writes).toHaveLength(2);
      expect(
        [...loggedError.mock.calls, ...loggedWarning.mock.calls].flat().map(String).join(' '),
      ).not.toContain(PRIVATE_ERROR);
    },
  );
});
