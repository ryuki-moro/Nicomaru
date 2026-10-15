import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { seedFixture, TestDb, type Fixture } from './harness';

let db: TestDb;
let fx: Fixture;
let notificationId: string;
const NOW = '2026-10-09T12:00:00Z';

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
  const result = await db.query<{ id: string }>(
    `insert into notifications (venue_id, case_id, recipient_user_id, channel, notification_type, title, body)
     values ($1, $2, $3, 'in_app', 'info', 'test', 'test') returning id`,
    [fx.venueId, fx.caseId, fx.couple.profileId],
  );
  notificationId = result.rows[0].id;
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.asOwner(async () => {
    await db.query('delete from system_alerts');
    await db.query('delete from usage_snapshots');
    await db.query('delete from batch_runs');
    await db.query('delete from ai_jobs');
    await db.query('delete from notification_logs');
    await db.query("delete from audit_logs where action = 'auth.login_failures'");
    await db.pg.exec(
      'create schema if not exists storage; create table if not exists storage.objects (metadata jsonb); truncate storage.objects;',
    );
    await snapshot(70, 70);
  });
});

async function snapshot(
  databaseBytes: number,
  storageBytes: number | null,
  options: {
    measuredAt?: string;
    databaseLimit?: number | null;
    storageLimit?: number | null;
  } = {},
) {
  await db.query(
    `insert into usage_snapshots
    (measured_on, measured_at, database_bytes, storage_bytes, database_limit_bytes, storage_limit_bytes,
     venue_count, case_count, user_count, file_count, notification_count, notification_failure_count)
    values ('2026-10-09', $1, $2, $3, $4, $5, 2, 3, 8, 0, 0, 0)
    on conflict (measured_on) do update set measured_at = excluded.measured_at,
      database_bytes = excluded.database_bytes, storage_bytes = excluded.storage_bytes,
      database_limit_bytes = excluded.database_limit_bytes, storage_limit_bytes = excluded.storage_limit_bytes`,
    [
      options.measuredAt ?? NOW,
      databaseBytes,
      storageBytes,
      options.databaseLimit === undefined ? 100 : options.databaseLimit,
      options.storageLimit === undefined ? 100 : options.storageLimit,
    ],
  );
}

async function evaluate(jobs: Record<string, number> = {}, now = NOW) {
  const result = await db.query<{
    active_count: number;
    published_count: number;
    resolved_count: number;
  }>('select * from evaluate_system_alerts($1, $2)', [JSON.stringify(jobs), now]);
  return result.rows[0];
}

async function activeKeys() {
  const result = await db.query<{ alert_key: string }>(
    'select alert_key from system_alerts where resolved_at is null order by alert_key',
  );
  return result.rows.map((row) => row.alert_key);
}

describe('日次の容量集計', () => {
  it('DB物理サイズとStorageの全オブジェクトを集計し、同日再実行は上書きする', async () => {
    await db.query('delete from usage_snapshots');
    await db.query(`insert into storage.objects values ('{"size": 20}'), ('{"size": "30"}')`);
    await db.query('select collect_usage_snapshot($1, $2)', [1000, 2000]);
    await db.query(`insert into storage.objects values ('{"size": 50}')`);
    await db.query('select collect_usage_snapshot($1, $2)', [1000, 2000]);
    const result = await db.query<{
      database_bytes: number;
      storage_bytes: number;
      venue_count: number;
      case_count: number;
    }>('select * from usage_snapshots');
    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0].database_bytes)).toBeGreaterThan(0);
    expect(Number(result.rows[0].storage_bytes)).toBe(100);
    expect(Number(result.rows[0].venue_count)).toBe(2);
    expect(Number(result.rows[0].case_count)).toBe(3);
  });

  it.each(['{}', '{"size": "not-a-number"}', '{"size": -1}'])(
    'Storageメタデータ不明を0にしない: %s',
    async (metadata) => {
      await db.query('insert into storage.objects values ($1)', [metadata]);
      const result = await db.query<{ storage_bytes: number | null }>(
        'select (collect_usage_snapshot()).storage_bytes',
      );
      expect(result.rows[0].storage_bytes).toBeNull();
    },
  );

  it('Storageテーブルがない環境を0にしない', async () => {
    await db.query('drop table storage.objects');
    const result = await db.query<{ storage_bytes: number | null }>(
      'select (collect_usage_snapshot()).storage_bytes',
    );
    expect(result.rows[0].storage_bytes).toBeNull();
  });

  it('無効な容量設定では記録を変更せず失敗する', async () => {
    await expect(db.query('select collect_usage_snapshot(-1, 100)')).rejects.toMatchObject({
      code: '22023',
    });
    const result = await db.query<{ database_bytes: number }>(
      'select database_bytes from usage_snapshots',
    );
    expect(Number(result.rows[0].database_bytes)).toBe(70);
  });

  it('集計保存に失敗した場合は日次スナップショットを部分更新しない', async () => {
    await db.pg
      .exec(`create function public.test_fail_usage_write() returns trigger language plpgsql as $$
      begin raise exception 'injected write failure'; end $$;
      create trigger test_fail_usage_write before insert or update on usage_snapshots
        for each row execute function public.test_fail_usage_write();`);
    try {
      await expect(db.query('select collect_usage_snapshot(1000, 1000)')).rejects.toMatchObject({
        code: 'P0001',
      });
      const result = await db.query<{ database_bytes: number }>(
        'select database_bytes from usage_snapshots',
      );
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].database_bytes)).toBe(70);
    } finally {
      await db.pg.exec(
        'drop trigger test_fail_usage_write on usage_snapshots; drop function public.test_fail_usage_write();',
      );
    }
  });
});

describe('容量70%と取得状態', () => {
  it('70%ちょうどでは発報せず、70%超でDB/Storageを個別に検知する', async () => {
    expect((await evaluate()).active_count).toBe(0);
    await snapshot(71, 71);
    expect((await evaluate()).active_count).toBe(2);
    expect(await activeKeys()).toEqual(['capacity_database', 'capacity_storage']);
  });
  it.each([
    { databaseLimit: null },
    { storageLimit: null },
    { measuredAt: '2026-10-07T11:59:59Z' },
  ])('上限未設定や期限切れを正常扱いしない: %o', async (options) => {
    await snapshot(70, 70, options);
    await evaluate();
    expect(await activeKeys()).toEqual(['capacity_unavailable']);
  });
  it('集計なしとStorage未取得を検知する', async () => {
    await db.query('delete from usage_snapshots');
    await evaluate();
    expect(await activeKeys()).toEqual(['capacity_unavailable']);
    await snapshot(70, null);
    await evaluate();
    expect(await activeKeys()).toEqual(['capacity_unavailable']);
  });
});

describe('6条件の検知', () => {
  it('バッチの直近失敗・間隔2倍超を検知し、無効なジョブは監視しない', async () => {
    await db.query(`insert into batch_runs (job_type, started_at, http_status) values
      ('risk_recalculate', '2026-10-07T11:59:59Z', 500),
      ('notifications_dispatch', '2026-10-07T12:00:00Z', 200),
      ('case_purge', '2026-10-07T11:00:00Z', 500)`);
    await evaluate({ risk_recalculate: 86400, notifications_dispatch: 86400 });
    expect(await activeKeys()).toEqual([
      'batch_failed:risk_recalculate',
      'batch_missing:risk_recalculate',
    ]);
  });
  it('実行履歴0件は監視開始から2倍間隔の猶予後に検知する', async () => {
    expect((await evaluate({ usage_rollup: 86400 })).active_count).toBe(0);
    await db.query(
      `insert into batch_runs (job_type, started_at) values ('monitoring', '2026-10-07T11:59:59Z')`,
    );
    await evaluate({ usage_rollup: 86400 });
    expect(await activeKeys()).toEqual(['batch_missing:usage_rollup']);
  });
  it('最後の死活監視が2回連続失敗した場合のみ検知する', async () => {
    await db.query(`insert into batch_runs (job_type, started_at, finished_at, http_status) values
      ('health_check', '2026-10-09T00:00:00Z', '2026-10-09T00:00:01Z', 500),
      ('health_check', '2026-10-09T06:00:00Z', '2026-10-09T06:00:01Z', 500)`);
    await evaluate();
    expect(await activeKeys()).toContain('health_failed');
    await db.query(`insert into batch_runs (job_type, started_at, finished_at, http_status)
      values ('health_check', '2026-10-09T11:00:00Z', '2026-10-09T11:00:01Z', 200)`);
    await evaluate();
    expect(await activeKeys()).not.toContain('health_failed');
  });
  it('AI失敗とprocessing30分超を検知する（30分ちょうどは対象外）', async () => {
    await db.query(
      `insert into ai_jobs (venue_id, job_type, input_ref, status, locked_at) values
      ($1, 'draft', '{}', 'failed', null),
      ($1, 'draft', '{}', 'processing', '2026-10-09T11:30:00Z')`,
      [fx.venueId],
    );
    await evaluate();
    expect(await activeKeys()).toEqual(['ai_failed']);
    await db.query(
      `update ai_jobs set locked_at = '2026-10-09T11:29:59Z' where status = 'processing'`,
    );
    await evaluate();
    expect(await activeKeys()).toEqual(['ai_failed', 'ai_stalled']);
  });
  it('通知失敗は日本時間の当日5件から検知し、前日の失敗を混ぜない', async () => {
    await db.query(
      `insert into notification_logs (notification_id, provider, status, created_at)
      select $1, 'email', 'failure', '2026-10-08T14:59:59Z'::timestamptz from generate_series(1, 5)`,
      [notificationId],
    );
    await db.query(
      `insert into notification_logs (notification_id, provider, status, created_at)
      select $1, 'email', 'failure', '2026-10-08T15:00:00Z'::timestamptz from generate_series(1, 4)`,
      [notificationId],
    );
    expect((await evaluate()).active_count).toBe(0);
    await db.query(
      `insert into notification_logs (notification_id, provider, status, created_at)
      values ($1, 'email', 'failure', '2026-10-09T11:00:00Z')`,
      [notificationId],
    );
    await evaluate();
    expect(await activeKeys()).toEqual(['notification_failures']);
  });
  it('認証集中イベントを検知するがHMAC等をアラートへ複写しない', async () => {
    await db.query(`insert into audit_logs (action, target_type, detail_json, created_at)
      values ('auth.login_failures', 'auth', '{"account_hash":"private-hash","count":10}', '2026-10-09T11:30:00Z')`);
    await evaluate();
    expect(await activeKeys()).toEqual(['auth_failures']);
    const rows = await db.query('select * from system_alerts');
    expect(JSON.stringify(rows)).not.toContain('private-hash');
    await evaluate({}, '2026-10-09T12:30:00Z');
    expect(await activeKeys()).not.toContain('auth_failures');
  });
});

describe('通知抑制・回復とアクセス制御', () => {
  it('同じ問題の通知を1時間抑制し、回復と再発を記録する', async () => {
    await snapshot(71, 70);
    expect((await evaluate()).published_count).toBe(1);
    expect((await evaluate({}, '2026-10-09T12:59:59Z')).published_count).toBe(0);
    expect((await evaluate({}, '2026-10-09T13:00:00Z')).published_count).toBe(1);
    await snapshot(70, 70);
    expect((await evaluate({}, '2026-10-09T13:01:00Z')).resolved_count).toBe(1);
    await snapshot(71, 70);
    expect((await evaluate({}, '2026-10-09T13:02:00Z')).published_count).toBe(1);
    const result = await db.query<{ occurrence_count: number }>(
      'select occurrence_count from system_alerts',
    );
    expect(result.rows[0].occurrence_count).toBe(3);
  });
  it('不正な監視設定は全体をロールバックして既存結果を変えない', async () => {
    await snapshot(71, 70);
    await evaluate();
    const invalidJobs: Record<string, number>[] = [
      { unknown: 10 },
      { risk_recalculate: 0 },
      { risk_recalculate: 604801 },
    ];
    for (const jobs of invalidJobs) {
      await expect(evaluate(jobs)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await activeKeys()).toEqual(['capacity_database']);
  });
  it('2件目のアラート保存が失敗したら1件目もロールバックする', async () => {
    await snapshot(71, 71);
    await db.pg
      .exec(`create function public.test_fail_alert_write() returns trigger language plpgsql as $$
      begin if new.alert_key = 'capacity_storage' then raise exception 'injected write failure'; end if;
        return new; end $$;
      create trigger test_fail_alert_write before insert on system_alerts
        for each row execute function public.test_fail_alert_write();`);
    try {
      await expect(evaluate()).rejects.toMatchObject({ code: 'P0001' });
      expect((await db.query('select * from system_alerts')).rows).toHaveLength(0);
    } finally {
      await db.pg.exec(
        'drop trigger test_fail_alert_write on system_alerts; drop function public.test_fail_alert_write();',
      );
    }
  });
  it('通常利用者は集計・監視RPCを実行できず、結果も参照できない', async () => {
    await snapshot(71, 70);
    await evaluate();
    await db.asUser(fx.planner.authUserId, async () => {
      expect((await db.query('select * from usage_snapshots')).rows).toHaveLength(0);
      expect((await db.query('select * from system_alerts')).rows).toHaveLength(0);
      await expect(db.query('select collect_usage_snapshot()')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(db.query("select evaluate_system_alerts('{}')")).rejects.toMatchObject({
        code: '42501',
      });
    });
  });
  it('system_adminも参照だけで、書き込みやRPC実行はできない', async () => {
    await snapshot(71, 70);
    await evaluate();
    await db.asUser(fx.systemAdmin.authUserId, async () => {
      expect((await db.query('select * from usage_snapshots')).rows).toHaveLength(1);
      expect((await db.query('select * from system_alerts')).rows).toHaveLength(1);
      await expect(db.query('delete from system_alerts')).rejects.toMatchObject({ code: '42501' });
      await expect(db.query('select collect_usage_snapshot()')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });
  it('service_roleだけが内部RPCを実行できる', async () => {
    await db.pg.exec('set role service_role');
    try {
      expect((await evaluate()).active_count).toBe(0);
    } finally {
      await db.pg.exec('reset role');
    }
  });
});
