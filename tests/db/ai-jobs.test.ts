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

describe('ai_assist_status（7-1 の「利用不可」表示／7-3 (4) の10分）', () => {
  it('心拍が無いうちは利用不可', async () => {
    const r = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ available: boolean; last_seen_at: string | null }>(
        'select * from ai_assist_status()'));
    expect(r.rows[0].available).toBe(false);
    expect(r.rows[0].last_seen_at).toBeNull();
  });

  it('心拍が10分以内なら利用可', async () => {
    await db.asOwner(() => db.query(`select ai_worker_ping('w1', 'gemma3:12b')`));

    const r = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ available: boolean }>('select * from ai_assist_status()'));
    expect(r.rows[0].available).toBe(true);
  });

  it('10分を超えたら利用不可へ倒れる', async () => {
    await db.asOwner(() =>
      db.query(`update ai_worker_heartbeats set last_seen_at = now() - interval '11 minutes'`));

    const r = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ available: boolean }>('select * from ai_assist_status()'));
    expect(r.rows[0].available).toBe(false);

    // 後続のテストへ影響させない
    await db.asOwner(() => db.query('delete from ai_worker_heartbeats'));
  });

  it('心拍表そのものは authenticated から読めない（関数だけを通す）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select * from ai_worker_heartbeats'));
      expect(code).toBe('42501');
    });
  });

  it('心拍の書き込みはワーカー専用ロールにだけ許す', async () => {
    const rows = await db.asOwner(() =>
      db.query<{ worker: boolean; auth: boolean }>(
        `select has_function_privilege('ai_worker', 'ai_worker_ping(text, text)', 'execute') as worker,
                has_function_privilege('authenticated', 'ai_worker_ping(text, text)', 'execute') as auth`));
    expect(rows.rows[0].worker).toBe(true);
    expect(rows.rows[0].auth).toBe(false);
  });
});

describe('enqueue_submission_ai_job（7-3 提出を契機とする投入）', () => {
  const call = 'select enqueue_submission_ai_job($1, $2, $3::jsonb)';
  const input = JSON.stringify({ text: 'BGMの希望があります', params: {} });

  it('couple も自案件の宿題からは投入できる（提出処理から呼ぶため）', async () => {
    const id = await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query<{ enqueue_submission_ai_job: string }>(
        call, [fx.taskId, 'classification', input]);
      return r.rows[0].enqueue_submission_ai_job;
    });
    expect(id).toBeTruthy();

    const row = await db.asOwner(() =>
      db.query<{ venue_id: string; case_id: string; status: string }>(
        'select venue_id, case_id, status from ai_jobs where id = $1', [id]));
    // venue_id・case_id は宿題から引く（引数で詐称できない）
    expect(row.rows[0].venue_id).toBe(fx.venueId);
    expect(row.rows[0].case_id).toBe(fx.caseId);
    expect(row.rows[0].status).toBe('queued');
  });

  it('未処理の同種ジョブがあれば積み増さない（一時保存の往復で溜めない）', async () => {
    const again = await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query<{ enqueue_submission_ai_job: string }>(
        call, [fx.taskId, 'classification', input]);
      return r.rows[0].enqueue_submission_ai_job;
    });

    const count = await db.asOwner(() =>
      db.query<{ n: string }>(
        `select count(*) as n from ai_jobs
          where related_task_id = $1 and job_type = 'classification'`, [fx.taskId]));
    expect(Number(count.rows[0].n)).toBe(1);
    expect(again).toBeTruthy();
  });

  it('提出から発生しない種別は投入できない', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() => db.query(call, [fx.taskId, 'draft', input]));
      expect(code).toBe('BH422');
    });
  });

  it('触れない案件の宿題には投入できない', async () => {
    await db.asUser(fx.otherPlanner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(call, [fx.taskId, 'classification', input]));
      expect(code).toBe('42501');
    });
  });
});

describe('review_ai_job の修正採用（7-2 の 9-1「プランナーが修正できる」）', () => {
  let jobId: string;

  beforeAll(async () => {
    const r = await db.asOwner(() =>
      db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status, output)
         values ($1, $2, 'classification', '{}'::jsonb, 'done',
                 '{"labels":["その他"],"confidence":0.4}'::jsonb)
         returning id`, [fx.venueId, fx.caseId]));
    jobId = r.rows[0].id;
  });

  it('修正した内容は reviewed_output に入り、AIの生出力は残る', async () => {
    const r = await db.asUser(fx.planner.authUserId, () =>
      db.query<{ review_ai_job: boolean }>(
        'select review_ai_job($1, $2, $3::jsonb)',
        [jobId, 'confirmed', JSON.stringify({ labels: ['料理・飲物'], confidence: 0.4 })]));
    expect(r.rows[0].review_ai_job).toBe(true);

    const after = await db.asOwner(() =>
      db.query<{ output: { labels: string[] }; reviewed_output: { labels: string[] } }>(
        'select output, reviewed_output from ai_jobs where id = $1', [jobId]));
    expect(after.rows[0].output.labels).toEqual(['その他']);
    expect(after.rows[0].reviewed_output.labels).toEqual(['料理・飲物']);
  });

  it('破棄では修正内容を残さない', async () => {
    const id = await db.asOwner(async () => {
      const r = await db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status, output)
         values ($1, $2, 'classification', '{}'::jsonb, 'done',
                 '{"labels":["その他"],"confidence":0.4}'::jsonb)
         returning id`, [fx.venueId, fx.caseId]);
      return r.rows[0].id;
    });

    await db.asUser(fx.planner.authUserId, () =>
      db.query('select review_ai_job($1, $2, $3::jsonb)',
        [id, 'discarded', JSON.stringify({ labels: ['費用'], confidence: 1 })]));

    const after = await db.asOwner(() =>
      db.query<{ status: string; reviewed_output: unknown }>(
        'select status, reviewed_output from ai_jobs where id = $1', [id]));
    expect(after.rows[0].status).toBe('discarded');
    expect(after.rows[0].reviewed_output).toBeNull();
  });
});

describe('purge_ai_job_payloads（7-4／13-1 の保持期間）', () => {
  it('完了から30日を過ぎた入出力だけを消し、メタ情報は残す', async () => {
    const id = await db.asOwner(async () => {
      const r = await db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, output, status,
                              model_name, attempts, finished_at, created_at)
         values ($1, $2, 'classification', '{"text":"個人情報を含みうる本文"}'::jsonb,
                 '{"labels":["費用"],"confidence":0.9}'::jsonb, 'confirmed',
                 'gemma3:12b', 1, now() - interval '31 days', now() - interval '31 days')
         returning id`, [fx.venueId, fx.caseId]);
      return r.rows[0].id;
    });

    const result = await db.asOwner(() =>
      db.query<{ payloads_cleared: number; rows_deleted: number }>(
        'select * from purge_ai_job_payloads(30, 90)'));
    expect(result.rows[0].payloads_cleared).toBeGreaterThanOrEqual(1);

    const after = await db.asOwner(() =>
      db.query<{ input_ref: unknown; output: unknown; model_name: string; attempts: number }>(
        'select input_ref, output, model_name, attempts from ai_jobs where id = $1', [id]));
    expect(after.rows[0].input_ref).toEqual({});
    expect(after.rows[0].output).toBeNull();
    // プロンプト改善の効果検証に要るメタ情報は残る（7-6）
    expect(after.rows[0].model_name).toBe('gemma3:12b');
    expect(after.rows[0].attempts).toBe(1);
  });

  it('未完了のジョブの入力は消さない（消すと必ず失敗する）', async () => {
    const id = await db.asOwner(async () => {
      const r = await db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status, created_at)
         values ($1, $2, 'draft', '{"text":"未処理"}'::jsonb, 'queued',
                 now() - interval '31 days')
         returning id`, [fx.venueId, fx.caseId]);
      return r.rows[0].id;
    });

    await db.asOwner(() => db.query('select * from purge_ai_job_payloads(30, 90)'));

    const after = await db.asOwner(() =>
      db.query<{ input_ref: { text?: string } }>(
        'select input_ref from ai_jobs where id = $1', [id]));
    expect(after.rows[0].input_ref.text).toBe('未処理');
  });

  it('作成から90日を過ぎた行は削除する', async () => {
    const id = await db.asOwner(async () => {
      const r = await db.query<{ id: string }>(
        `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status, created_at)
         values ($1, $2, 'draft', '{}'::jsonb, 'done', now() - interval '91 days')
         returning id`, [fx.venueId, fx.caseId]);
      return r.rows[0].id;
    });

    const result = await db.asOwner(() =>
      db.query<{ rows_deleted: number }>('select * from purge_ai_job_payloads(30, 90)'));
    expect(result.rows[0].rows_deleted).toBeGreaterThanOrEqual(1);

    const after = await db.asOwner(() =>
      db.query('select id from ai_jobs where id = $1', [id]));
    expect(after.rows).toHaveLength(0);
  });

  it('利用者からは呼べない（定期処理からのみ）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() => db.query('select * from purge_ai_job_payloads(30, 90)'));
      expect(code).toBe('42501');
    });
  });
});
