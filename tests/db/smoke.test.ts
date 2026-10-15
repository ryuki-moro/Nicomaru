import { describe, expect, it } from 'vitest';
import { TestDb, seedFixture } from './harness';

describe('マイグレーション', () => {
  it('全マイグレーションと seed が適用できる', async () => {
    const db = await TestDb.create();
    const fx = await seedFixture(db);
    expect(fx.caseId).toBeTruthy();
    const r = await db.query<{ n: number }>('select count(*)::int as n from task_templates');
    expect(r.rows[0].n).toBe(8);
    await db.close();
  });
});

describe('service_role の権限（20260828002200・表6-4）', () => {
  it('既存の表・関数と、後から作った表の両方に DML 権限を持つ', async () => {
    const db = await TestDb.create();

    // 一括 grant は実行時点の表にしか効かない。代表として最後に作られた表で確かめる。
    const existing = await db.query<{ ok: boolean }>(
      `select has_table_privilege('service_role', 'public.ai_worker_heartbeats', 'select, insert, update, delete') as ok`,
    );
    expect(existing.rows[0].ok).toBe(true);

    const fn = await db.query<{ ok: boolean }>(
      `select has_function_privilege('service_role', 'public.consume_invitation(text, text)', 'execute') as ok`,
    );
    expect(fn.rows[0].ok).toBe(true);

    // default privileges により、以降のマイグレーションで作る表にも自動で付く。
    await db.query('create table public._probe_after_grant (id int primary key)');
    const later = await db.query<{ ok: boolean }>(
      `select has_table_privilege('service_role', 'public._probe_after_grant', 'select, insert, update, delete') as ok`,
    );
    expect(later.rows[0].ok).toBe(true);

    await db.close();
  });
});

describe('register_scheduled_jobs（20260828002300・6-12）', () => {
  it('pg_cron が無い環境では 0 を返して何もしない', async () => {
    const db = await TestDb.create();
    const r = await db.query<{ n: number }>(
      `select register_scheduled_jobs('https://example.test', 'secret') as n`,
    );
    expect(r.rows[0].n).toBe(0);
    await db.close();
  });

  it('PostgREST のロールからは呼べない', async () => {
    const db = await TestDb.create();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const r = await db.query<{ ok: boolean }>(
        `select has_function_privilege('${role}', 'public.register_scheduled_jobs(text, text)', 'execute') as ok`,
      );
      expect(r.rows[0].ok, role).toBe(false);
    }
    await db.close();
  });
});
