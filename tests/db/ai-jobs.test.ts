/**
 * AIジョブキューの権限と状態遷移（Phase 3、機能9-6）。
 *
 * 正本: 基本設計書 Version 1.2 7-1／7-3／7-6／付録A。
 *
 *   - 7-1「出力は必ずプランナーの確認を経て利用する（自動送信・自動登録は行わない）」
 *   - 7-3「ワーカーには Service Role Key を配布せず、
 *          ジョブ取得と結果書き込みのみを許す RPC をワーカー専用ロールへ付与する」
 *   - 付録A「ai_jobs は couple には自案件かつ job_type='faq_answer' の行のみ select を許可する」
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture } from './harness';

let db: TestDb;
let fx: Fixture;

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
});

afterAll(async () => {
  await db?.close();
});

async function errcodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return e.code ?? e.message ?? 'unknown';
  }
}

const enqueue = 'select enqueue_ai_job($1, $2, $3::jsonb, null)';

describe('enqueue_ai_job（7-3 ジョブの投入）', () => {
  it('planner は自担当案件にジョブを投入できる', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const r = await db.query<{ enqueue_ai_job: string }>(
        enqueue, [fx.caseId, 'classification', JSON.stringify({ text: 'サンプル', params: {} })]);
      expect(r.rows[0].enqueue_ai_job).toBeTruthy();
    });
  });

  it('venue_id は案件から引かれる（引数で詐称できない）', async () => {
    const row = await db.asOwner(() =>
      db.query<{ venue_id: string }>(
        'select venue_id from ai_jobs order by created_at desc limit 1'));
    expect(row.rows[0].venue_id).toBe(fx.venueId);
  });

  it('couple は投入できない（couple 向けは専用APIから。7-3）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(enqueue, [fx.caseId, 'classification', JSON.stringify({ params: {} })]));
      expect(code).toBe('42501');
    });
  });

  it('触れない案件には投入できない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(enqueue, [fx.otherCaseId, 'draft', JSON.stringify({ params: {} })]));
      expect(code).toBe('42501');
    });
  });
});

describe('ジョブの参照範囲（付録A ai_jobs_select）', () => {
  it('planner は自担当案件のジョブを参照できる', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query('select id from ai_jobs where case_id = $1', [fx.caseId]));
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('couple には faq_answer 以外は見せない', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id from ai_jobs'));
    expect(rows.rows).toHaveLength(0);
  });

  it('couple は自案件の faq_answer だけ参照できる（7-5）', async () => {
    await db.asOwner(() =>
      db.query(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status)
         values ($1, $2, 'faq_answer', '{}'::jsonb, 'done')`, [fx.venueId, fx.caseId]));

    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query<{ job_type: string }>('select job_type from ai_jobs'));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].job_type).toBe('faq_answer');
  });
});

describe('review_ai_job（7-1 プランナー確認の担保）', () => {
  let jobId: string;

  beforeAll(async () => {
    const r = await db.asOwner(() =>
      db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status)
         values ($1, $2, 'draft', '{}'::jsonb, 'queued') returning id`,
        [fx.venueId, fx.caseId]));
    jobId = r.rows[0].id;
  });

  it('done でないジョブは採用できない（生成前の出力を採用させない）', async () => {
    const r = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ review_ai_job: boolean }>(
        'select review_ai_job($1, $2)', [jobId, 'confirmed']));
    expect(r.rows[0].review_ai_job).toBe(false);
  });

  it('done なら採用でき、確認者が記録される', async () => {
    await db.asOwner(() =>
      db.query(`update ai_jobs set status = 'done' where id = $1`, [jobId]));

    const r = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ review_ai_job: boolean }>(
        'select review_ai_job($1, $2)', [jobId, 'confirmed']));
    expect(r.rows[0].review_ai_job).toBe(true);

    const after = await db.asOwner(() =>
      db.query<{ status: string; confirmed_by: string }>(
        'select status, confirmed_by from ai_jobs where id = $1', [jobId]));
    expect(after.rows[0].status).toBe('confirmed');
    expect(after.rows[0].confirmed_by).toBe(fx.planner.profileId);
  });

  it('確認結果の値域は confirmed / discarded に限る', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query('select review_ai_job($1, $2)', [jobId, 'done']));
      expect(code).toBe('BH422');
    });
  });

  it('couple は採用できない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query('select review_ai_job($1, $2)', [jobId, 'confirmed']));
      expect(code).toBe('42501');
    });
  });
});

describe('ワーカー用RPCの権限（7-3）', () => {
  it('authenticated はジョブ取得のRPCを呼べない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select * from claim_ai_job($1, null)', ['w']));
      expect(code).toBe('42501');
    });
  });

  it('authenticated は結果書き込みのRPCを呼べない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query('select complete_ai_job($1, $2, null, null, null)',
          [fx.caseId, 'w']));
      expect(code).toBe('42501');
    });
  });

  it('ワーカー専用ロールにだけ EXECUTE が付いている', async () => {
    const rows = await db.asOwner(() =>
      db.query<{ has: boolean }>(
        `select has_function_privilege('ai_worker', 'claim_ai_job(text, text[])', 'execute') as has`));
    expect(rows.rows[0].has).toBe(true);
  });

  it('ワーカーロールは ai_jobs を直接読み書きできない（鍵ではなく操作を絞る）', async () => {
    const rows = await db.asOwner(() =>
      db.query<{ has: boolean }>(
        `select has_table_privilege('ai_worker', 'ai_jobs', 'select') as has`));
    expect(rows.rows[0].has).toBe(false);
  });
});

describe('reclaim_stalled_ai_jobs（7-3／6-12 滞留回収）', () => {
  it('閾値を超えた processing を queued へ戻す', async () => {
    const id = await db.asOwner(async () => {
      const r = await db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status, locked_by, locked_at, attempts)
         values ($1, $2, 'draft', '{}'::jsonb, 'processing', 'dead-worker', now() - interval '60 minutes', 1)
         returning id`, [fx.venueId, fx.caseId]);
      return r.rows[0].id;
    });

    const result = await db.asOwner(() =>
      db.query<{ requeued: number; failed: number }>(
        'select * from reclaim_stalled_ai_jobs(30, 3)'));
    expect(result.rows[0].requeued).toBe(1);

    const after = await db.asOwner(() =>
      db.query<{ status: string; locked_by: string | null }>(
        'select status, locked_by from ai_jobs where id = $1', [id]));
    expect(after.rows[0].status).toBe('queued');
    expect(after.rows[0].locked_by).toBeNull();
  });

  it('試行上限に達したものは failed で固定する', async () => {
    const id = await db.asOwner(async () => {
      const r = await db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status, locked_by, locked_at, attempts)
         values ($1, $2, 'draft', '{}'::jsonb, 'processing', 'dead-worker', now() - interval '60 minutes', 3)
         returning id`, [fx.venueId, fx.caseId]);
      return r.rows[0].id;
    });

    const result = await db.asOwner(() =>
      db.query<{ requeued: number; failed: number }>(
        'select * from reclaim_stalled_ai_jobs(30, 3)'));
    expect(result.rows[0].failed).toBe(1);

    const after = await db.asOwner(() =>
      db.query<{ status: string; error_message: string }>(
        'select status, error_message from ai_jobs where id = $1', [id]));
    expect(after.rows[0].status).toBe('failed');
    expect(after.rows[0].error_message).toContain('試行回数の上限');
  });

  it('閾値内の processing は戻さない（動いているワーカーを邪魔しない）', async () => {
    await db.asOwner(() =>
      db.query(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status, locked_by, locked_at)
         values ($1, $2, 'draft', '{}'::jsonb, 'processing', 'alive', now())`,
        [fx.venueId, fx.caseId]));

    const result = await db.asOwner(() =>
      db.query<{ requeued: number; failed: number }>(
        'select * from reclaim_stalled_ai_jobs(30, 3)'));
    expect(result.rows[0].requeued).toBe(0);
    expect(result.rows[0].failed).toBe(0);
  });
});
