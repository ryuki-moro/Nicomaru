import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const table = (overrides: Record<string, unknown> = {}) => ({
  name: '1卓',
  capacity: 8,
  shape: 'round',
  x: 0.25,
  y: 0.4,
  allowedTags: ['side:groom', 'relationship:friend'],
  ...overrides,
});

const save = (
  authUserId: string,
  caseId: string,
  layoutId: string | null,
  tables: unknown[],
  name = '円卓 8卓',
) =>
  db.asUser(authUserId, async () => {
    const res = await db.query<{ id: string }>(
      'select save_seating_layout($1, $2, $3, $4, $5::jsonb) as id',
      [caseId, layoutId, name, 'wide', JSON.stringify(tables)],
    );
    return res.rows[0].id;
  });

const visibleLayouts = (authUserId: string, caseId: string) =>
  db.asUser(authUserId, async () =>
    (
      await db.query<{ id: string }>('select id from seating_layouts where case_id = $1', [caseId])
    ).rows.map((r) => r.id),
  );

const tablesOf = (authUserId: string, layoutId: string) =>
  db.asUser(
    authUserId,
    async () =>
      (
        await db.query<{ id: string; name: string; allowed_tags: string[] }>(
          'select id, name, allowed_tags from seating_tables where layout_id = $1 order by sort_order',
          [layoutId],
        )
      ).rows,
  );

const offer = (authUserId: string, layoutId: string, on: boolean) =>
  db.asUser(authUserId, () =>
    db.query('select set_seating_layout_offered($1, $2)', [layoutId, on]),
  );

describe('卓の配置パターン（#180）', () => {
  let layoutId: string;

  it('担当プランナーは配置パターンを作れ、保存し直しても卓の ID が保たれる', async () => {
    layoutId = await save(fx.planner.authUserId, fx.caseId, null, [
      table(),
      table({ name: '2卓', x: 0.75 }),
    ]);
    const first = await tablesOf(fx.planner.authUserId, layoutId);
    expect(first.map((t) => t.name)).toEqual(['1卓', '2卓']);
    // 座れる人は、重複を除いて送った順のまま残る
    expect(first[0].allowed_tags).toEqual(['side:groom', 'relationship:friend']);

    // 1卓は名前を変え、2卓は消し、3卓を足す
    await save(fx.planner.authUserId, fx.caseId, layoutId, [
      table({ id: first[0].id, name: '新郎友人', allowedTags: ['side:groom', 'side:groom'] }),
      table({ name: '3卓', y: 0.7, allowedTags: [] }),
    ]);
    const second = await tablesOf(fx.planner.authUserId, layoutId);
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({
      id: first[0].id,
      name: '新郎友人',
      allowed_tags: ['side:groom'],
    });
    expect(second[1]).toMatchObject({ name: '3卓', allowed_tags: [] });
  });

  it('新郎新婦には、送られたパターンとその卓だけが見える', async () => {
    expect(await visibleLayouts(fx.couple.authUserId, fx.caseId)).toEqual([]);
    expect(await tablesOf(fx.couple.authUserId, layoutId)).toEqual([]);

    await offer(fx.planner.authUserId, layoutId, true);
    expect(await visibleLayouts(fx.couple.authUserId, fx.caseId)).toEqual([layoutId]);
    expect(await tablesOf(fx.couple.authUserId, layoutId)).toHaveLength(2);

    await offer(fx.planner.authUserId, layoutId, false);
    expect(await visibleLayouts(fx.couple.authUserId, fx.caseId)).toEqual([]);
  });

  it('新郎新婦は配置パターンを作れず、送ることも、表を直接書き換えることもできない', async () => {
    await offer(fx.planner.authUserId, layoutId, true);
    await expect(save(fx.couple.authUserId, fx.caseId, null, [table()])).rejects.toMatchObject({
      code: '42501',
    });
    await expect(offer(fx.couple.authUserId, layoutId, false)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query("update seating_layouts set name = '直接' where id = $1", [layoutId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query('update seating_tables set capacity = 20 where layout_id = $1', [layoutId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asUser(fx.planner.authUserId, () =>
        db.query('delete from seating_tables where layout_id = $1', [layoutId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('担当外のプランナーは見ることも変えることもできない', async () => {
    expect(await visibleLayouts(fx.otherPlanner.authUserId, fx.caseId)).toEqual([]);
    await expect(
      save(fx.otherPlanner.authUserId, fx.caseId, null, [table()]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      db.asUser(fx.otherPlanner.authUserId, () =>
        db.query('select delete_seating_layout($1)', [layoutId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('アーカイブ済みの案件では作れない（会場管理者でも）', async () => {
    await expect(
      save(fx.planner.authUserId, fx.archivedCaseId, null, [table()]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      save(fx.admin.authUserId, fx.archivedCaseId, null, [table()]),
    ).rejects.toMatchObject({
      code: 'BH422',
    });
  });

  it('別の配置パターンの卓、使えない条件、卓の数の範囲外は拒否する', async () => {
    const otherLayout = await save(fx.planner.authUserId, fx.caseId, null, [table()], '別の配置');
    const [foreign] = await tablesOf(fx.planner.authUserId, otherLayout);
    await expect(
      save(fx.planner.authUserId, fx.caseId, layoutId, [table({ id: foreign.id })]),
    ).rejects.toMatchObject({ code: 'BH422' });
    await expect(
      save(fx.planner.authUserId, fx.caseId, layoutId, [table({ allowedTags: ['DROP TABLE'] })]),
    ).rejects.toMatchObject({ code: 'BH422' });
    // 存在しない自由タグ
    await expect(
      save(fx.planner.authUserId, fx.caseId, layoutId, [
        table({ allowedTags: ['tag:00000000-0000-0000-0000-000000000000'] }),
      ]),
    ).rejects.toMatchObject({ code: 'BH422' });
    await expect(save(fx.planner.authUserId, fx.caseId, layoutId, [])).rejects.toMatchObject({
      code: 'BH422',
    });
    await expect(
      save(fx.planner.authUserId, fx.caseId, layoutId, [table({ capacity: 21 })]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('担当プランナーは配置パターンを消せ、卓も一緒に消える', async () => {
    await db.asUser(fx.planner.authUserId, () =>
      db.query('select delete_seating_layout($1)', [layoutId]),
    );
    expect(await visibleLayouts(fx.planner.authUserId, fx.caseId)).not.toContain(layoutId);
    const rest = await db.asOwner(() =>
      db.query('select id from seating_tables where layout_id = $1', [layoutId]),
    );
    expect(rest.rows).toHaveLength(0);
  });
});
