import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, seedFixture, type Fixture, type SeededUser } from './harness';

let db: TestDb;
let fx: Fixture;
const FIRST = '2026-10-14T01:00:00.000Z';
const SECOND = '2026-10-15T02:00:00.000Z';

beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
});
afterAll(async () => {
  await db?.close();
});

async function login(user: SeededUser, timestamp: string | null) {
  await db.asOwner(() =>
    db.query('update auth.users set last_sign_in_at = $1 where id = $2', [
      timestamp,
      user.authUserId,
    ]),
  );
}
async function lastLogin(user: SeededUser) {
  const result = await db.asOwner(() =>
    db.query<{ value: Date | null }>(
      'select last_login_at as value from user_profiles where id = $1',
      [user.profileId],
    ),
  );
  return result.rows[0].value?.toISOString() ?? null;
}

describe('成功ログイン時刻の同期', () => {
  it('couple・staffとも本人のプロフィールだけ更新する', async () => {
    expect(await lastLogin(fx.couple)).toBeNull();
    await login(fx.couple, FIRST);
    await login(fx.planner, SECOND);
    expect(await lastLogin(fx.couple)).toBe(FIRST);
    expect(await lastLogin(fx.planner)).toBe(SECOND);
    expect(await lastLogin(fx.partner)).toBeNull();
  });

  it('成功時刻を進め、時刻不変・無関係なAuth更新・古い値・NULLでは進めない/戻さない', async () => {
    await login(fx.couple, SECOND);
    await db.asOwner(() =>
      db.query('update auth.users set email = email where id = $1', [fx.couple.authUserId]),
    );
    await login(fx.couple, SECOND);
    await login(fx.couple, FIRST);
    await login(fx.couple, null);
    expect(await lastLogin(fx.couple)).toBe(SECOND);
  });

  it('停止中・削除済み・招待中には記録しない', async () => {
    await login(fx.suspendedPlanner, SECOND);
    expect(await lastLogin(fx.suspendedPlanner)).toBeNull();
    for (const status of ['invited', 'deleted']) {
      await db.asOwner(() =>
        db.query('update user_profiles set status = $1 where id = $2', [
          status,
          fx.otherPlanner.profileId,
        ]),
      );
      await login(fx.otherPlanner, status === 'invited' ? FIRST : SECOND);
      expect(await lastLogin(fx.otherPlanner)).toBeNull();
    }
  });

  it('招待のactive化時に認証済み時刻を同期する', async () => {
    await db.asOwner(() =>
      db.query("update user_profiles set status = 'invited' where id = $1", [fx.admin.profileId]),
    );
    await login(fx.admin, SECOND);
    expect(await lastLogin(fx.admin)).toBeNull();
    await db.asOwner(() =>
      db.query("update user_profiles set status = 'active' where id = $1", [fx.admin.profileId]),
    );
    expect(await lastLogin(fx.admin)).toBe(SECOND);
  });

  it('認証後に作られるプロフィールにも時刻を設定する（初回登録）', async () => {
    await db.asOwner(async () => {
      const auth = await db.query<{ id: string }>(
        'insert into auth.users (email, last_sign_in_at) values ($1, $2) returning id',
        ['new@example.test', SECOND],
      );
      const result = await db.query<{ value: Date }>(
        `insert into user_profiles (auth_user_id, venue_id, role, display_name, email) values ($1, $2, 'couple', 'New', 'new@example.test') returning last_login_at as value`,
        [auth.rows[0].id, fx.venueId],
      );
      expect(result.rows[0].value.toISOString()).toBe(SECOND);
    });
  });

  it('本人セッションでも任意の未来日時やNULLに改ざんできない', async () => {
    await login(fx.partner, FIRST);
    for (const timestamp of ['2099-01-01T00:00:00Z', null]) {
      await db.asUser(fx.partner.authUserId, () =>
        db.query('update user_profiles set last_login_at = $1 where id = $2', [
          timestamp,
          fx.partner.profileId,
        ]),
      );
      expect(await lastLogin(fx.partner)).toBe(FIRST);
    }
  });

  it('通常のプロフィール更新はログイン日時を更新しない', async () => {
    await db.asUser(fx.partner.authUserId, () =>
      db.query('update user_profiles set display_name = $1 where id = $2', [
        'Updated name',
        fx.partner.profileId,
      ]),
    );
    expect(await lastLogin(fx.partner)).toBe(FIRST);
    await db.asOwner(() =>
      db.query('update user_profiles set display_name = $1 where id = $2', [
        'Never logged in',
        fx.otherVenueAdmin.profileId,
      ]),
    );
    expect(await lastLogin(fx.otherVenueAdmin)).toBeNull();
  });

  it('停止前の日時を保ち、停止中の認証では進めない', async () => {
    await login(fx.otherVenueAdmin, FIRST);
    await db.asOwner(() =>
      db.query("update user_profiles set status = 'suspended' where id = $1", [
        fx.otherVenueAdmin.profileId,
      ]),
    );
    await login(fx.otherVenueAdmin, SECOND);
    expect(await lastLogin(fx.otherVenueAdmin)).toBe(FIRST);
  });

  it('認証トランザクションの取り消しでプロフィール側も巻き戻る', async () => {
    await db.asOwner(async () => {
      await db.pg.exec('begin');
      try {
        await db.query('update auth.users set last_sign_in_at = $1 where id = $2', [
          SECOND,
          fx.partner.authUserId,
        ]);
        const result = await db.query<{ value: Date }>(
          'select last_login_at as value from user_profiles where id = $1',
          [fx.partner.profileId],
        );
        expect(result.rows[0].value.toISOString()).toBe(SECOND);
      } finally {
        await db.pg.exec('rollback');
      }
    });
    expect(await lastLogin(fx.partner)).toBe(FIRST);
  });

  it('authenticatedはAuthの正本や同期関数に直接アクセスできない', async () => {
    await expect(
      db.asUser(fx.couple.authUserId, () =>
        db.query('update auth.users set last_sign_in_at = now()'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    for (const fn of ['sync_auth_last_login', 'set_profile_last_login']) {
      await expect(
        db.asUser(fx.couple.authUserId, () => db.query(`select public.${fn}()`)),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('停止解除や直接更新で停止中のAuth時刻を活動へ取り込まない', async () => {
    await db.asOwner(() =>
      db.query(
        "update user_profiles set status = 'suspended', last_login_at = null where id = $1",
        [fx.otherPlanner.profileId],
      ),
    );
    await login(fx.otherPlanner, SECOND);
    await db.asOwner(() =>
      db.query("update user_profiles set status = 'active' where id = $1", [
        fx.otherPlanner.profileId,
      ]),
    );
    expect(await lastLogin(fx.otherPlanner)).toBeNull();
    await db.asUser(fx.otherPlanner.authUserId, () =>
      db.query("update user_profiles set last_login_at = '2099-01-01' where id = $1", [
        fx.otherPlanner.profileId,
      ]),
    );
    expect(await lastLogin(fx.otherPlanner)).toBeNull();
    const freshLogin = '2026-10-16T03:00:00.000Z';
    await login(fx.otherPlanner, freshLogin);
    expect(await lastLogin(fx.otherPlanner)).toBe(freshLogin);
  });

  it('migrationは既存activeプロフィールの成功時刻を補完する', async () => {
    await db.asOwner(async () => {
      await db.pg.exec(
        'drop trigger sync_auth_last_login on auth.users; drop trigger set_profile_last_login on user_profiles; drop function sync_auth_last_login(); drop function set_profile_last_login();',
      );
      await db.query('update user_profiles set last_login_at = null where id = $1', [
        fx.couple.profileId,
      ]);
      await db.query('update auth.users set last_sign_in_at = $1 where id = $2', [
        SECOND,
        fx.couple.authUserId,
      ]);
      await db.pg.exec(
        readFileSync('supabase/migrations/20261015000100_record_last_login.sql', 'utf8'),
      );
    });
    expect(await lastLogin(fx.couple)).toBe(SECOND);
    expect(await lastLogin(fx.suspendedPlanner)).toBeNull();
    expect(await lastLogin(fx.otherVenueAdmin)).toBe(FIRST);
  });
});
