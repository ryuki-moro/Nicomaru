import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture } from './harness';

let db: TestDb;
let fx: Fixture;
let guestId: string;
let otherGuestId: string;

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
  await db.asOwner(async () => {
    guestId = (
      await db.query<{ id: string }>(
        "insert into case_guests (case_id, full_name) values ($1, 'enc:guest') returning id",
        [fx.caseId],
      )
    ).rows[0].id;
    otherGuestId = (
      await db.query<{ id: string }>(
        "insert into case_guests (case_id, full_name) values ($1, 'enc:other') returning id",
        [fx.otherCaseId],
      )
    ).rows[0].id;
  });
});

afterAll(async () => {
  await db?.close();
});

const createTag = (authUserId: string, caseId: string, name: string) =>
  db.asUser(authUserId, () =>
    db.query<{ id: string }>(
      'insert into case_guest_tags (case_id, name) values ($1, $2) returning id',
      [caseId, name],
    ),
  );

const linkedTags = (authUserId: string, id: string) =>
  db.asUser(authUserId, () =>
    db.query<{ tag_id: string }>(
      'select tag_id from case_guest_tag_links where guest_id = $1 order by tag_id',
      [id],
    ),
  );

describe('ゲストの自由タグ', () => {
  let tagA: string;
  let tagB: string;

  it('新郎新婦は自案件にタグを作れるが、同名（大文字小文字・空白違い）は作れない', async () => {
    tagA = (await createTag(fx.couple.authUserId, fx.caseId, '大学の友人')).rows[0].id;
    tagB = (await createTag(fx.couple.authUserId, fx.caseId, 'Circle')).rows[0].id;
    await expect(createTag(fx.couple.authUserId, fx.caseId, ' circle ')).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('担当外の案件にはタグを作れず、タグも見えない', async () => {
    await expect(createTag(fx.couple.authUserId, fx.otherCaseId, '他案件')).rejects.toMatchObject({
      code: '42501',
    });
    const rows = await db.asUser(fx.otherPlanner.authUserId, () =>
      db.query('select id from case_guest_tags where case_id = $1', [fx.caseId]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('新郎新婦が付けたタグを担当プランナーが確認・付け替えできる', async () => {
    await db.asUser(fx.couple.authUserId, () =>
      db.query('select set_guest_tags($1, $2::uuid[])', [guestId, [tagA, tagB]]),
    );
    expect((await linkedTags(fx.planner.authUserId, guestId)).rows).toHaveLength(2);

    await db.asUser(fx.planner.authUserId, () =>
      db.query('select set_guest_tags($1, $2::uuid[])', [guestId, [tagB]]),
    );
    expect((await linkedTags(fx.couple.authUserId, guestId)).rows).toEqual([{ tag_id: tagB }]);
  });

  it('対応表は直接書き換えられない', async () => {
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query('insert into case_guest_tag_links (guest_id, tag_id) values ($1, $2)', [
          guestId,
          tagA,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('別案件のゲスト・別案件のタグには付けられない', async () => {
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query('select set_guest_tags($1, $2::uuid[])', [otherGuestId, [tagA]]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const otherTag = await db.asOwner(() =>
      db.query<{ id: string }>(
        "insert into case_guest_tags (case_id, name) values ($1, '他案件のタグ') returning id",
        [fx.otherCaseId],
      ),
    );
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query('select set_guest_tags($1, $2::uuid[])', [guestId, [otherTag.rows[0].id]]),
      ),
    ).rejects.toMatchObject({ code: 'BH422' });
  });

  it('タグを消すとゲストからも外れる', async () => {
    await db.asUser(fx.couple.authUserId, () =>
      db.query('delete from case_guest_tags where id = $1', [tagB]),
    );
    expect((await linkedTags(fx.couple.authUserId, guestId)).rows).toHaveLength(0);
  });
});
