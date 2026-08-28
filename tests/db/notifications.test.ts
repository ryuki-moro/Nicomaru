/**
 * 通知の RLS と送信上限（Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-9／7-1〜7-3／付録A。
 *
 *   - LINE の送信上限は「案件あたり週1通」「式場あたり月180通」
 *   - 上限到達時はメールへ切り替える（通知自体は落とさない）ため、
 *     ここでは claim_line_quota() が false を返すことを確かめる
 *   - 「片方だけ加算されたまま false」にならないこと（サブトランザクションで巻き戻す）
 *   - 通知の作成は planner／admin のみ。宛先は案件に属する利用者に限る
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

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

async function errcodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return e.code ?? e.message ?? 'unknown';
  }
}

const createSql = 'select create_notification($1, $2, $3, $4, $5, $6)';

describe('create_notification（機能7-1）', () => {
  it('planner は自担当案件の couple 宛に作成できる', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const r = await db.query<{ create_notification: string }>(
        createSql,
        [fx.caseId, fx.couple.profileId, 'in_app', 'due_reminder', '件名', '本文']);
      expect(r.rows[0].create_notification).toBeTruthy();
    });
  });

  it('couple は作成できない（通知はプランナーが送るもの）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(createSql,
          [fx.caseId, fx.couple.profileId, 'in_app', 'info', '件名', '本文']));
      expect(code).toBe('42501');
    });
  });

  it('案件に属さない利用者は宛先にできない（任意の user_profiles.id を渡せない）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(createSql,
          [fx.caseId, fx.otherPlanner.profileId, 'in_app', 'info', '件名', '本文']));
      expect(code).toBe('BH422');
    });
  });

  it('触れない案件には作成できない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query(createSql,
          [fx.otherCaseId, fx.couple.profileId, 'in_app', 'info', '件名', '本文']));
      expect(code).toBe('42501');
    });
  });
});

describe('通知の参照範囲（付録A notifications_select）', () => {
  it('受信者本人は自分宛の通知を参照できる', async () => {
    const rows = await db.asUser(fx.couple.authUserId, () =>
      db.query('select id from notifications'));
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('担当プランナーは案件の通知を参照できる（N01）', async () => {
    const rows = await db.asUser(fx.planner.authUserId, () =>
      db.query('select id from notifications where case_id = $1', [fx.caseId]));
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('別式場の admin からは見えない', async () => {
    const rows = await db.asUser(fx.otherVenueAdmin.authUserId, () =>
      db.query('select id from notifications'));
    expect(rows.rows).toHaveLength(0);
  });

  it('受信者は既読化できる（read_at の更新）', async () => {
    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query(
        `update notifications set read_at = now(), status = 'read'
          where recipient_user_id = $1 returning id`, [fx.couple.profileId]);
      expect(r.rows.length).toBeGreaterThan(0);
    });
  });
});

describe('claim_line_quota（6-9 LINE送信上限）', () => {
  it('既定では案件あたり週1通まで', async () => {
    await db.asOwner(async () => {
      const first = await db.query<{ claim_line_quota: boolean }>(
        'select claim_line_quota($1, $2)', [fx.caseId, fx.venueId]);
      expect(first.rows[0].claim_line_quota).toBe(true);

      const second = await db.query<{ claim_line_quota: boolean }>(
        'select claim_line_quota($1, $2)', [fx.caseId, fx.venueId]);
      expect(second.rows[0].claim_line_quota).toBe(false);
    });
  });

  it('上限で false を返したとき、式場側のカウンタも加算されていない', async () => {
    // 「片方だけ加算されたまま false」を許すと、案件が上限に達しただけで
    // 式場の月枠まで削られる。サブトランザクションで巻き戻していることを確かめる。
    const venueCount = await db.asOwner(() =>
      db.query<{ sent_count: number }>(
        `select sent_count from notification_quota_counters
          where scope = 'venue_month' and scope_id = $1`, [fx.venueId]));
    // 成功した1通ぶんだけが数えられている
    expect(venueCount.rows[0].sent_count).toBe(1);
  });

  it('別の案件なら同じ週でも送れる（枠は案件ごと）', async () => {
    const other = await db.asOwner(async () => {
      const r = await db.query<{ id: string }>(
        `insert into wedding_cases
           (venue_id, plan_type_id, primary_planner_id, case_code, wedding_date)
         values ($1, null, $2, 'BRIDAL01-2026-0777', current_date + 90) returning id`,
        [fx.venueId, fx.planner.profileId]);
      return r.rows[0].id;
    });

    const result = await db.asOwner(() =>
      db.query<{ claim_line_quota: boolean }>(
        'select claim_line_quota($1, $2)', [other, fx.venueId]));
    expect(result.rows[0].claim_line_quota).toBe(true);
  });

  it('式場の月上限に達すると、未使用の案件でも false になる', async () => {
    await db.asOwner(async () => {
      // 式場の月上限を2に絞る（設定はコード直書きではなくテーブルで持つ。6-9）
      await db.query(
        `insert into notification_settings (venue_id, line_per_case_per_week, line_per_venue_per_month)
         values ($1, 99, 2)`, [fx.venueId]);

      const fresh = await db.query<{ id: string }>(
        `insert into wedding_cases
           (venue_id, plan_type_id, primary_planner_id, case_code, wedding_date)
         values ($1, null, $2, 'BRIDAL01-2026-0778', current_date + 90) returning id`,
        [fx.venueId, fx.planner.profileId]);

      // 既に2通ぶん（上のテストで case×2）使っているため、次は式場上限で弾かれる
      const r = await db.query<{ claim_line_quota: boolean }>(
        'select claim_line_quota($1, $2)', [fresh.rows[0].id, fx.venueId]);
      expect(r.rows[0].claim_line_quota).toBe(false);
    });
  });

  it('カウンタは authenticated から直接触れない（付録A の auth_rate_limits と同じ扱い）', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const code = await errcodeOf(() =>
        db.query('select * from notification_quota_counters'));
      expect(code).toBe('42501');
    });
  });
});

describe('notification_settings', () => {
  it('planner は参照できるが変更はできない', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const rows = await db.query('select id from notification_settings');
      expect(rows.rows.length).toBeGreaterThan(0);

      const updated = await db.query(
        'update notification_settings set line_per_case_per_week = 9 returning id');
      expect(updated.rows).toHaveLength(0);
    });
  });

  it('admin は自式場の設定を変更できる', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const r = await db.query(
        'update notification_settings set line_per_case_per_week = 3 where venue_id = $1 returning id',
        [fx.venueId]);
      expect(r.rows).toHaveLength(1);
    });
  });

  it('システム既定（venue_id is null）は admin からは変更できない', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const r = await db.query(
        'update notification_settings set line_per_case_per_week = 9 where venue_id is null returning id');
      expect(r.rows).toHaveLength(0);
    });
  });
});
