/**
 * 模擬データの投入を実 PostgreSQL で確かめる（Issue #24）。
 *
 * demo-seed.test.ts（PGlite）と違い、scripts/seed-demo.mts が実際に使う接続部分
 * （scripts/demo/pgDb.ts：ロールの切り替えと JWT クレームの受け渡し）を通す。
 * 途中で失敗したときに丸ごと戻ること（トランザクション）もここで確かめる。
 *
 * TEST_PG_URL が無ければ skip する（tests/db/pg-harness.ts の方針）。CI では concurrency-db ジョブで走る。
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEMO_CASES } from '../../scripts/demo/scenario';
import { pgDemoDb } from '../../scripts/demo/pgDb';
import { resetDemo, seedDemo, type DemoAuth } from '../../scripts/demo/seed';
import { createTestDatabase, hasRealPg } from './pg-harness';

describe.skipIf(!hasRealPg)('模擬データの投入（実PostgreSQL）', () => {
  let client: Client;

  const auth: DemoAuth = {
    async ensureUser(email) {
      const found = await client.query<{ id: string }>('select id from auth.users where email = $1', [email]);
      if (found.rows[0]) return found.rows[0].id;
      const created = await client.query<{ id: string }>(
        'insert into auth.users (email) values ($1) returning id',
        [email],
      );
      return created.rows[0].id;
    },
  };

  const options = { plannerPassword: 'unused', today: '2026-11-01', appBaseUrl: 'http://127.0.0.1:3000' };

  beforeAll(async () => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.PII_HMAC_KEY = randomBytes(32).toString('base64');
    client = new Client({ connectionString: await createTestDatabase('nicomaru_demo_seed') });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('利用者の権限で案件・宿題・提出・確認まで作れる', async () => {
    const result = await seedDemo(pgDemoDb(client), auth, options);
    expect(result.created).toHaveLength(DEMO_CASES.length);

    const statuses = await client.query<{ status: string; n: number }>(
      `select ct.status, count(*)::int as n
         from case_tasks ct join wedding_cases wc on wc.id = ct.case_id
        where wc.notes like '[demo:%' group by ct.status`,
    );
    const byStatus = Object.fromEntries(statuses.rows.map((r) => [r.status, r.n]));
    expect(byStatus.needs_fix).toBe(1);
    expect(byStatus.submitted).toBeGreaterThanOrEqual(3);
    expect(byStatus.confirmed).toBeGreaterThanOrEqual(4);
  });

  it('終わったあとは所有者ロールに戻っている（後続の処理を巻き込まない）', async () => {
    const role = await client.query<{ current_user: string; sub: string | null }>(
      `select current_user, nullif(current_setting('request.jwt.claim.sub', true), '') as sub`,
    );
    expect(role.rows[0].current_user).toBe('postgres');
    expect(role.rows[0].sub).toBeNull();
  });

  it('途中で失敗したらトランザクションごと戻り、半端な案件が残らない', async () => {
    const db = pgDemoDb(client);
    await resetDemo(db);

    const failingAuth: DemoAuth = {
      async ensureUser(email, opts) {
        // 2件目の案件の新郎新婦を作るところで落とす
        if (email.startsWith('demo-02')) throw new Error('auth down');
        return auth.ensureUser(email, opts);
      },
    };

    await client.query('begin');
    await expect(seedDemo(db, failingAuth, options)).rejects.toThrow('auth down');
    await client.query('rollback');

    const left = await client.query<{ n: number }>(
      `select count(*)::int as n from wedding_cases where notes like '[demo:%'`,
    );
    expect(left.rows[0].n).toBe(0);
  });
});
