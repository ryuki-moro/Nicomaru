import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture } from './harness';

let db: TestDb;
let fixture: Fixture;

beforeAll(async () => {
  db = await TestDb.create();
  fixture = await seedFixture(db);
});
afterAll(async () => {
  await db?.close();
});

describe('式場更新のRLS', () => {
  it('system_adminは式場名・代表メール・利用状態を更新できる', async () => {
    const result = await db.asUser(fixture.systemAdmin.authUserId, () =>
      db.query<{
        name: string;
        contact_email: string | null;
        active: boolean;
        code: string;
      }>(
        `update venues set name = '検証式場', contact_email = null, active = false
        where id = $1 returning name, contact_email, active, code`,
        [fixture.venueId],
      ),
    );
    expect(result.rows).toEqual([
      {
        name: '検証式場',
        contact_email: null,
        active: false,
        code: 'BRIDAL01',
      },
    ]);
  });

  it('admin・planner・couple・別式場admin・停止利用者・未認証は式場を更新できない', async () => {
    const before = await db.asOwner(() =>
      db.query<{ name: string }>('select name from venues where id = $1', [fixture.venueId]),
    );
    const actors = [
      fixture.admin,
      fixture.planner,
      fixture.couple,
      fixture.otherVenueAdmin,
      fixture.suspendedPlanner,
    ];
    for (const authUserId of [...actors.map((actor) => actor.authUserId), null]) {
      const result = await db.asUser(authUserId, () =>
        db.query(`update venues set name = '権限外更新' where id = $1 returning id`, [
          fixture.venueId,
        ]),
      );
      expect(result.rows).toHaveLength(0);
    }
    const after = await db.asOwner(() =>
      db.query<{ name: string }>('select name from venues where id = $1', [fixture.venueId]),
    );
    expect(after.rows[0].name).toBe(before.rows[0].name);
  });
});
