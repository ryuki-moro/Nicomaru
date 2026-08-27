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
