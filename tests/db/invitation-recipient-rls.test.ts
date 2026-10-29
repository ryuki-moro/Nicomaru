import { beforeAll, afterAll, describe, it, expect } from 'vitest';
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
describe('招待先メールのスタッフ更新RLS', () => {
  it('自担当案件の未登録相手の宛先は保存できる', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query(
        'update couple_profiles set email=$1,email_hash=$2 where case_id=$3 and partner_role=$4 and email is null returning id',
        ['encrypted:test', 'hash-test', fx.caseId, 'bride'],
      ),
    );
    expect(rows.rows).toHaveLength(1);
  });
  it('他案件の宛先は更新できない', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query('update couple_profiles set email=$1,email_hash=$2 where case_id=$3 returning id', [
        'encrypted:other',
        'hash-other',
        fx.otherCaseId,
      ]),
    );
    expect(rows.rows).toHaveLength(0);
  });
  it('もう一方のプロフィールと同じ宛先はDBでも拒否する', async () => {
    await expect(
      db.asUser(fx.planner.authUserId, () =>
        db.query(
          "update couple_profiles set email='encrypted:same', email_hash='hash-test' where case_id=$1 and partner_role='groom'",
          [fx.caseId],
        ),
      ),
    ).rejects.toMatchObject({ code: 'BH422' });
  });
  it('プロフィールと重なる別パートナーの招待発行も拒否する', async () => {
    await expect(
      db.asUser(fx.planner.authUserId, () =>
        db.query(
          "select reissue_case_invitation($1, 'groom', 'initial_registration', 'duplicate-token', 'email', now()+interval '14 days', 1, 'encrypted:same', 'hash-test')",
          [fx.caseId],
        ),
      ),
    ).rejects.toMatchObject({ code: 'BH422' });
  });
  it('別パートナーの有効招待と同じ宛先も拒否するが、失効後は保存できる', async () => {
    await db.asUser(fx.planner.authUserId, () =>
      db.query(
        "select reissue_case_invitation($1, 'groom', 'initial_registration', 'active-token', 'email', now()+interval '14 days', 1, 'encrypted:active', 'active-hash')",
        [fx.caseId],
      ),
    );
    const save = () =>
      db.asUser(fx.planner.authUserId, () =>
        db.query(
          "update couple_profiles set email='encrypted:active', email_hash='active-hash' where case_id=$1 and partner_role='bride'",
          [fx.caseId],
        ),
      );
    await expect(save()).rejects.toMatchObject({ code: 'BH422' });
    await db.query("update case_invitations set revoked_at=now() where token_hash='active-token'");
    await expect(save()).resolves.toBeDefined();
  });
});
