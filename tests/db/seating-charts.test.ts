import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture } from './harness';

let db: TestDb;
let fx: Fixture;
let layoutId: string;
let hiddenLayoutId: string;
let groomTable: string;
let brideTable: string;
let smallTable: string;
const guests: Record<string, string> = {};

const insertGuest = async (
  key: string,
  caseId: string,
  side: 'groom' | 'bride',
  relationship: string,
  options: { checked?: boolean; attending?: boolean } = {},
) => {
  const { checked = true, attending = true } = options;
  guests[key] = (
    await db.query<{ id: string }>(
      `insert into case_guests (case_id, full_name, invitation_status, guest_side, relationship, checked_at)
       values ($1, 'enc:guest', $2, $3, $4, $5) returning id`,
      [
        caseId,
        attending ? 'reply_yes' : 'reply_no',
        side,
        relationship,
        checked ? new Date().toISOString() : null,
      ],
    )
  ).rows[0].id;
};

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
  await db.asOwner(async () => {
    // 二人目（新婦）もこの案件に紐付け、二人での同時編集を試せるようにする
    await db.query(
      "update couple_profiles set user_profile_id = $1 where case_id = $2 and partner_role = 'bride'",
      [fx.partner.profileId, fx.caseId],
    );
    await insertGuest('groomFriend', fx.caseId, 'groom', 'friend');
    await insertGuest('groomFriend2', fx.caseId, 'groom', 'friend');
    await insertGuest('brideColleague', fx.caseId, 'bride', 'colleague');
    await insertGuest('unchecked', fx.caseId, 'groom', 'friend', { checked: false });
    await insertGuest('declined', fx.caseId, 'groom', 'friend', { attending: false });
    await insertGuest('otherCase', fx.otherCaseId, 'groom', 'friend');
  });

  const saveLayout = (name: string, tables: unknown[]) =>
    db.asUser(
      fx.planner.authUserId,
      async () =>
        (
          await db.query<{ id: string }>(
            "select save_seating_layout($1, null, $2, 'wide', $3::jsonb) as id",
            [fx.caseId, name, JSON.stringify(tables)],
          )
        ).rows[0].id,
    );
  const t = (name: string, capacity: number, allowedTags: string[]) => ({
    name,
    capacity,
    shape: 'round',
    x: 0.3,
    y: 0.4,
    allowedTags,
  });
  layoutId = await saveLayout('送った配置', [
    t('新郎友人', 8, ['side:groom', 'relationship:friend']),
    t('新婦職場', 8, ['side:bride', 'relationship:colleague']),
    t('小さい卓', 2, []),
  ]);
  hiddenLayoutId = await saveLayout('送っていない配置', [t('1卓', 8, [])]);
  await db.asUser(fx.planner.authUserId, () =>
    db.query('select set_seating_layout_offered($1, true)', [layoutId]),
  );
  const rows = await db.asOwner(() =>
    db.query<{ id: string; name: string }>(
      'select id, name from seating_tables where layout_id = $1',
      [layoutId],
    ),
  );
  const byName = (n: string) => rows.rows.find((r) => r.name === n)!.id;
  groomTable = byName('新郎友人');
  brideTable = byName('新婦職場');
  smallTable = byName('小さい卓');
});

afterAll(async () => {
  await db?.close();
});

type Pair = [guestKey: string, tableId: string];

const save = (
  authUserId: string,
  version: number,
  pairs: Pair[],
  layout: string | null = layoutId,
) =>
  db.asUser(
    authUserId,
    async () =>
      (
        await db.query<{ v: number }>('select save_seating_chart($1, $2, $3, $4::jsonb) as v', [
          fx.caseId,
          layout,
          version,
          JSON.stringify(pairs.map(([g, tableId]) => ({ guestId: guests[g], tableId }))),
        ])
      ).rows[0].v,
  );

const submit = (authUserId: string, version: number) =>
  db.asUser(
    authUserId,
    async () =>
      (
        await db.query<{ v: number }>('select submit_seating_chart($1, $2) as v', [
          fx.caseId,
          version,
        ])
      ).rows[0].v,
  );

const chart = () =>
  db.asOwner(async () => {
    const c = await db.query<{ status: string; version: number; layout_id: string | null }>(
      'select status, version, layout_id from seating_charts where case_id = $1',
      [fx.caseId],
    );
    const a = await db.query<{ guest_id: string; table_id: string; seat_order: number }>(
      'select guest_id, table_id, seat_order from seating_assignments where case_id = $1 order by table_id, seat_order',
      [fx.caseId],
    );
    return { ...c.rows[0], assignments: a.rows };
  });

describe('新郎新婦がつくる席次（#181）', () => {
  it('新郎新婦は送られた配置パターンで席を決めて保存でき、並びが席順になる', async () => {
    const v = await save(fx.couple.authUserId, 0, [
      ['groomFriend2', groomTable],
      ['groomFriend', groomTable],
    ]);
    expect(v).toBe(1);
    const c = await chart();
    expect(c).toMatchObject({ status: 'draft', version: 1, layout_id: layoutId });
    expect(c.assignments.map((a) => [a.guest_id, a.seat_order])).toEqual([
      [guests.groomFriend2, 0],
      [guests.groomFriend, 1],
    ]);
  });

  it('もう一人が先に保存していたら、古い版からの保存は BH409 で断る', async () => {
    await expect(save(fx.couple.authUserId, 0, [])).rejects.toMatchObject({ code: 'BH409' });
    // 最新の版からなら保存できる
    expect(await save(fx.couple.authUserId, 1, [['groomFriend', groomTable]])).toBe(2);
  });

  it('卓の「座れる人」の条件・定員・確認済みでない方・送られていない配置は断る', async () => {
    await expect(
      save(fx.couple.authUserId, 2, [['brideColleague', groomTable]]),
    ).rejects.toMatchObject({
      code: 'BH422',
    });
    await expect(
      save(fx.couple.authUserId, 2, [
        ['groomFriend', smallTable],
        ['groomFriend2', smallTable],
        ['brideColleague', smallTable],
      ]),
    ).rejects.toMatchObject({ code: 'BH422' });
    await expect(save(fx.couple.authUserId, 2, [['unchecked', groomTable]])).rejects.toMatchObject({
      code: 'BH422',
    });
    await expect(save(fx.couple.authUserId, 2, [['declined', groomTable]])).rejects.toMatchObject({
      code: 'BH422',
    });
    await expect(save(fx.couple.authUserId, 2, [['otherCase', groomTable]])).rejects.toMatchObject({
      code: 'BH422',
    });
    await expect(save(fx.couple.authUserId, 2, [], hiddenLayoutId)).rejects.toMatchObject({
      code: 'BH422',
    });
    // 断られた保存は何も変えない
    expect((await chart()).version).toBe(2);
  });

  it('新郎新婦が直したご関係で条件を判定する', async () => {
    await db.asOwner(() =>
      db.query("update case_guests set relationship_override = 'friend' where id = $1", [
        guests.brideColleague,
      ]),
    );
    // 新婦職場の卓には座れなくなる
    await expect(
      save(fx.couple.authUserId, 2, [['brideColleague', brideTable]]),
    ).rejects.toMatchObject({
      code: 'BH422',
    });
    await db.asOwner(() =>
      db.query('update case_guests set relationship_override = null where id = $1', [
        guests.brideColleague,
      ]),
    );
  });

  it('プランナー・担当外の利用者は保存できず、表への直接の書き込みもできない', async () => {
    await expect(save(fx.planner.authUserId, 2, [])).rejects.toMatchObject({ code: '42501' });
    await expect(save(fx.otherPlanner.authUserId, 2, [])).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query("update seating_charts set status = 'approved' where case_id = $1", [fx.caseId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query('delete from seating_assignments where case_id = $1', [fx.caseId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 担当プランナーは見える
    const seen = await db.asUser(fx.planner.authUserId, () =>
      db.query('select guest_id from seating_assignments where case_id = $1', [fx.caseId]),
    );
    expect(seen.rows).toHaveLength(1);
  });

  it('未配置の方がいると提出できず、全員が決まれば提出でき、提出後は変更できない', async () => {
    await expect(submit(fx.couple.authUserId, 2)).rejects.toMatchObject({ code: 'BH422' });
    const v = await save(fx.couple.authUserId, 2, [
      ['groomFriend', groomTable],
      ['groomFriend2', groomTable],
      ['brideColleague', brideTable],
    ]);
    // 二人目の新郎新婦が古い版で提出しようとしても断る
    await expect(submit(fx.partner.authUserId, v - 1)).rejects.toMatchObject({ code: 'BH409' });
    expect(await submit(fx.partner.authUserId, v)).toBe(v + 1);
    expect((await chart()).status).toBe('submitted');

    await expect(save(fx.couple.authUserId, v + 1, [])).rejects.toMatchObject({ code: 'BH422' });
    await expect(submit(fx.couple.authUserId, v + 1)).rejects.toMatchObject({ code: 'BH422' });
  });

  it('アーカイブ済みの案件では保存できない', async () => {
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query("select save_seating_chart($1, null, 0, '[]'::jsonb)", [fx.archivedCaseId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
