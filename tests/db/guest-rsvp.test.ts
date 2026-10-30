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

/** Service Role（表6-4 'guest.rsvp'）として実行する。API と同じ経路。 */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('reset role');
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await db.query('set role service_role');
  try {
    return await fn();
  } finally {
    await db.query('reset role');
  }
}

const person = (name: string, extra: Record<string, unknown> = {}) => ({
  full_name: name,
  kana: '',
  age_category: 'adult',
  gender: 'female',
  allergy_note: '',
  ...extra,
});

function submit(tokenHash: string, attending: boolean, guests: unknown[]) {
  return asService(() =>
    db.query<{ group_id: string | null }>(
      "select submit_guest_response($1, $2, 'bride', 'friend', $3::jsonb) as group_id",
      [tokenHash, attending, JSON.stringify(guests)],
    ),
  );
}

describe('ゲスト回答URLの発行', () => {
  it('新郎新婦は自案件の回答URLを発行でき、切り替えると前のURLは失効する', async () => {
    for (const hash of ['form-hash-1', 'form-hash-2']) {
      await db.asUser(fx.couple.authUserId, () =>
        db.query('select reissue_guest_form($1, $2, $3)', [fx.caseId, hash, `enc:${hash}`]),
      );
    }
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query<{ token_hash: string; revoked_at: string | null }>(
        'select token_hash, revoked_at from case_guest_forms where case_id = $1 order by created_at, token_hash',
        [fx.caseId],
      ),
    );
    expect(rows.rows.filter((r) => r.revoked_at === null).map((r) => r.token_hash)).toEqual([
      'form-hash-2',
    ]);
  });

  it('担当外のプランナーは発行できない', async () => {
    await expect(
      db.asUser(fx.otherPlanner.authUserId, () =>
        db.query('select reissue_guest_form($1, $2, $3)', [fx.caseId, 'other-hash', 'enc']),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('回答URLの表は直接書き換えられない', async () => {
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query('update case_guest_forms set revoked_at = null where case_id = $1', [fx.caseId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('担当外のプランナーからは回答URLが見えない', async () => {
    const rows = await db.asUser(fx.otherPlanner.authUserId, () =>
      db.query('select id from case_guest_forms where case_id = $1', [fx.caseId]),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe('ゲストの回答登録', () => {
  it('ログイン中の利用者からは回答関数を直接呼べない', async () => {
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query(
          "select submit_guest_response('form-hash-2', true, 'bride', 'friend', '[]'::jsonb)",
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('本人と同伴者を同じ回答として登録し、新郎新婦とプランナーが参照できる', async () => {
    const result = await submit('form-hash-2', true, [
      person('enc:本人', { allergy_note: 'enc:えび' }),
      person('enc:同伴', { age_category: 'child', gender: 'male' }),
    ]);
    const groupId = result.rows[0].group_id;
    expect(groupId).toBeTruthy();

    for (const user of [fx.couple, fx.planner]) {
      const rows = await db.asUser(user.authUserId, () =>
        db.query<{
          is_companion: boolean;
          invitation_status: string;
          age_category: string;
          allergy_note: string | null;
          guest_side: string;
          relationship: string;
        }>(
          `select is_companion, invitation_status, age_category, allergy_note, guest_side, relationship
             from case_guests where response_group_id = $1 order by is_companion`,
          [groupId],
        ),
      );
      expect(rows.rows).toEqual([
        {
          is_companion: false,
          invitation_status: 'reply_yes',
          age_category: 'adult',
          allergy_note: 'enc:えび',
          guest_side: 'bride',
          relationship: 'friend',
        },
        {
          is_companion: true,
          invitation_status: 'reply_yes',
          age_category: 'child',
          allergy_note: null,
          guest_side: 'bride',
          relationship: 'friend',
        },
      ]);
    }

    const other = await db.asUser(fx.otherPlanner.authUserId, () =>
      db.query('select id from case_guests where response_group_id = $1', [groupId]),
    );
    expect(other.rows).toHaveLength(0);
  });

  it('欠席の回答ではアレルギーを保存せず、同伴者は付けられない', async () => {
    const result = await submit('form-hash-2', false, [
      person('enc:欠席', { allergy_note: 'enc:そば' }),
    ]);
    const rows = await db.asOwner(() =>
      db.query<{ invitation_status: string; allergy_note: string | null }>(
        'select invitation_status, allergy_note from case_guests where response_group_id = $1',
        [result.rows[0].group_id],
      ),
    );
    expect(rows.rows).toEqual([{ invitation_status: 'reply_no', allergy_note: null }]);

    await expect(
      submit('form-hash-2', false, [person('enc:a'), person('enc:b')]),
    ).rejects.toMatchObject({ code: 'BH422' });
  });

  it('切り替え前のURL・存在しないURLでは登録されない', async () => {
    for (const hash of ['form-hash-1', 'unknown-hash']) {
      const result = await submit(hash, true, [person('enc:x')]);
      expect(result.rows[0].group_id).toBeNull();
    }
  });

  it('不正な区分値はDBでも拒否する', async () => {
    await expect(
      submit('form-hash-2', true, [person('enc:x', { age_category: 'senior' })]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('回答画面には挙式日と新郎新婦の氏名だけを返す', async () => {
    const rows = await asService(() =>
      db.query<Record<string, unknown>>("select * from peek_guest_form('form-hash-2')"),
    );
    expect(rows.rows).toHaveLength(1);
    expect(Object.keys(rows.rows[0]).sort()).toEqual(
      ['bride_name_enc', 'groom_name_enc', 'wedding_date'].sort(),
    );
    const none = await asService(() => db.query("select * from peek_guest_form('form-hash-1')"));
    expect(none.rows).toHaveLength(0);
  });
});
