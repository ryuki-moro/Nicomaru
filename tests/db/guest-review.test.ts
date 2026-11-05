import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture } from './harness';

let db: TestDb;
let fx: Fixture;
let attendingId: string;
let declinedId: string;
let archivedGuestId: string;

const insertGuest = (caseId: string, status: string) =>
  db.asOwner(async () => {
    const result = await db.query<{ id: string }>(
      `insert into case_guests (case_id, full_name, relationship, guest_side, invitation_status)
       values ($1, 'enc:guest', 'other', 'groom', $2) returning id`,
      [caseId, status],
    );
    return result.rows[0].id;
  });

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
  attendingId = await insertGuest(fx.caseId, 'reply_yes');
  declinedId = await insertGuest(fx.caseId, 'reply_no');
  archivedGuestId = await insertGuest(fx.archivedCaseId, 'reply_yes');
});

afterAll(async () => {
  await db?.close();
});

const review = (authUserId: string, guestId: string, patch: Record<string, unknown>) =>
  db.asUser(authUserId, () =>
    db.query('select review_case_guest($1, $2::jsonb)', [guestId, JSON.stringify(patch)]),
  );

const guestRow = (id: string) =>
  db.asOwner(async () => {
    const result = await db.query<{
      checked_at: string | null;
      relationship: string;
      relationship_override: string | null;
      seat_role: string | null;
      seat_title: string | null;
    }>(
      `select checked_at, relationship, relationship_override, seat_role, seat_title
         from case_guests where id = $1`,
      [id],
    );
    return result.rows[0];
  });

describe('ゲスト一覧の確認（#179）', () => {
  it('新しく届いた回答は確認待ちで、新郎新婦が確認済みにでき、プランナーが戻せる', async () => {
    expect((await guestRow(attendingId)).checked_at).toBeNull();
    await review(fx.couple.authUserId, attendingId, { checked: true });
    expect((await guestRow(attendingId)).checked_at).not.toBeNull();
    await review(fx.planner.authUserId, attendingId, { checked: false });
    expect((await guestRow(attendingId)).checked_at).toBeNull();
  });

  it('ご関係を直しても回答の値は残り、回答と同じ値に戻すと修正が取り消される', async () => {
    await review(fx.couple.authUserId, attendingId, { relationship: 'colleague' });
    expect(await guestRow(attendingId)).toMatchObject({
      relationship: 'other',
      relationship_override: 'colleague',
    });
    await review(fx.couple.authUserId, attendingId, { relationship: 'other' });
    expect((await guestRow(attendingId)).relationship_override).toBeNull();
  });

  it('送った項目だけを変え、役割と肩書きは null で消せる', async () => {
    await review(fx.couple.authUserId, attendingId, {
      checked: true,
      seat_role: 'chief',
      seat_title: ' 新郎上司 ',
    });
    await review(fx.couple.authUserId, attendingId, { seat_title: null });
    expect(await guestRow(attendingId)).toMatchObject({ seat_role: 'chief', seat_title: null });
    expect((await guestRow(attendingId)).checked_at).not.toBeNull();
  });

  it('欠席の方は確認済みにできない', async () => {
    await expect(review(fx.couple.authUserId, declinedId, { checked: true })).rejects.toMatchObject(
      { code: 'BH422' },
    );
  });

  it('担当外の利用者とアーカイブ済みの案件は変更できない', async () => {
    await expect(
      review(fx.otherPlanner.authUserId, attendingId, { checked: true }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      review(fx.admin.authUserId, archivedGuestId, { checked: true }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('不正な役割はDBでも拒否する', async () => {
    await expect(
      review(fx.couple.authUserId, attendingId, { seat_role: 'mc' }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
