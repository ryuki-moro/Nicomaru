/**
 * リスクスコアの保存と実行記録の RLS（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-8／6-12／付録A。
 *
 *   - リスクは planner／admin 向けの情報であり couple には見せない（6-3-2／5-1）
 *   - 現在値は case_id ごと1件（部分ユニーク risk_score_snapshots_current_uk）
 *   - 定期処理の実行記録は system_admin のみ参照でき、書き込みは内部処理に限る（6-12）
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

const saveSql = 'select save_risk_snapshot($1, $2, $3, $4, $5::jsonb)';

describe('save_risk_snapshot（6-8）', () => {
  it('planner は自担当案件の結果を保存できる', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const r = await db.query<{ save_risk_snapshot: string }>(
        saveSql, [fx.caseId, 55, 'high', null, JSON.stringify([{ conditionKey: 'task_overdue' }])]);
      expect(r.rows[0].save_risk_snapshot).toBeTruthy();
    });
  });

  it('再計算すると現在値は1件に保たれる（旧値は is_current=false になる）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      await db.query(saveSql, [fx.caseId, 20, 'caution', null, JSON.stringify([])]);
      await db.query(saveSql, [fx.caseId, 40, 'high', null, JSON.stringify([])]);
    });

    const current = await db.asOwner(() =>
      db.query<{ n: number }>(
        'select count(*)::int as n from risk_score_snapshots where case_id = $1 and is_current',
        [fx.caseId]));
    expect(current.rows[0].n).toBe(1);

    const history = await db.asOwner(() =>
      db.query<{ n: number }>(
        'select count(*)::int as n from risk_score_snapshots where case_id = $1', [fx.caseId]));
    // 履歴は残る（6-8「算出結果は risk_score_snapshots に保存」）
    expect(history.rows[0].n).toBeGreaterThan(1);
  });

  it('couple は保存できない（リスクは planner／admin 向けの情報）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(saveSql, [fx.caseId, 90, 'high', null, JSON.stringify([])]));
      expect(code).toBe('42501');
    });
  });

  it('couple は算出結果を参照できない', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id from risk_score_snapshots'));
    expect(rows.rows).toHaveLength(0);
  });

  it('planner は自担当案件の算出結果を参照できる', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query('select id from risk_score_snapshots where case_id = $1 and is_current',
        [fx.caseId]));
    expect(rows.rows).toHaveLength(1);
  });

  it('他式場の案件には保存できない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(saveSql, [fx.otherCaseId, 50, 'high', null, JSON.stringify([])]));
      expect(code).toBe('42501');
    });
  });

  it('アーカイブ済み案件には保存できない', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(saveSql, [fx.archivedCaseId, 50, 'high', null, JSON.stringify([])]));
      expect(code).toBe('42501');
    });
  });

  it('スコアの値域は DB 側でも縛られる（0〜100）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(saveSql, [fx.caseId, 120, 'high', null, JSON.stringify([])]));
      expect(code).toBe('23514');
    });
  });
});

describe('batch_runs（6-12 実行記録）', () => {
  beforeAll(async () => {
    await db.asOwner(() =>
      db.query(
        `insert into batch_runs (job_type, target_count, http_status)
         values ('risk_recalculate', 3, 200)`));
  });

  it('system_admin は実行記録を参照できる', async () => {
    const rows = await db.asUser(fx.systemAdmin.authUserId, () =>
      db.query('select id, job_type from batch_runs'));
    expect(rows.rows).toHaveLength(1);
  });

  it('planner／admin からは見えない（S03 は system_admin 向け）', async () => {
    for (const user of [fx.planner, fx.admin]) {
      const rows = await db.asUser(user.authUserId, () => db.query('select id from batch_runs'));
      expect(rows.rows).toHaveLength(0);
    }
  });

  it('authenticated からは書き込めない（内部処理に限る）', async () => {
    await db.asUser(fx.systemAdmin.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(`insert into batch_runs (job_type) values ('risk_recalculate')`));
      expect(code).toBe('42501');
    });
  });

  it('job_type は 6-12 の一覧に無い値を受け付けない', async () => {
    await db.asOwner(async () => {
      const code = await errcodeOf(() =>
        db.query(`insert into batch_runs (job_type) values ('unknown_job')`));
      expect(code).toBe('23514');
    });
  });
});
