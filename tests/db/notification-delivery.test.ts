import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
async function create(channel = 'email') {
  const r = await db.query<{ id: string }>(
    `insert into notifications
    (venue_id, case_id, recipient_user_id, channel, notification_type, title, body)
    values ($1,$2,$3,$4,'overdue','件名','本文') returning id`,
    [fx.venueId, fx.caseId, fx.couple.profileId, channel],
  );
  return r.rows[0].id;
}
async function claim(id: string) {
  return (
    await db.query<{
      claim_token: string;
      attempt_count: number;
      payload: Record<string, string>;
      retry_key: string;
    }>(`select * from claim_notification_delivery($1, 'sender@example.test')`, [id])
  ).rows[0];
}
describe('通知の送信権と再試行', () => {
  it('送信権は1つだけで、期限切れ後も宛先・本文・キーを固定する', async () => {
    const id = await create();
    const first = await claim(id);
    expect(first.attempt_count).toBe(1);
    expect(await claim(id)).toBeUndefined();
    await db.query(
      `update notification_deliveries set lease_until=now()-interval '1 second' where notification_id=$1`,
      [id],
    );
    await db.query(`update notifications set title='変更', body='変更' where id=$1`, [id]);
    const second = await claim(id);
    expect(second.attempt_count).toBe(2);
    expect(second.retry_key).toBe(first.retry_key);
    expect(second.payload).toEqual(first.payload);
    expect(second.claim_token).not.toBe(first.claim_token);
    const stale = await db.query<{ finish_notification_delivery: boolean }>(
      `select finish_notification_delivery($1,$2,'accepted',null)`,
      [id, first.claim_token],
    );
    expect(stale.rows[0].finish_notification_delivery).toBe(false);
  });
  it('結果不明は再試行待ちになり、23時間を過ぎたら自動再送しない', async () => {
    const id = await create();
    const first = await claim(id);
    await db.query(`select finish_notification_delivery($1,$2,'unknown',null)`, [
      id,
      first.claim_token,
    ]);
    expect(await claim(id)).toBeUndefined();
    await db.query(
      `update notification_deliveries set next_attempt_at=now()-interval '1 second', first_requested_at=now()-interval '24 hours' where notification_id=$1`,
      [id],
    );
    expect(await claim(id)).toBeUndefined();
    const r = await db.query<{ state: string; last_result: string }>(
      `select state,last_result from notification_deliveries where notification_id=$1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ state: 'review', last_result: 'retry_window_expired' });
  });
  it('受付済み・ログを同時に保存し、既読状態は上書きしない', async () => {
    const id = await create();
    const first = await claim(id);
    await db.query(`update notifications set status='read',read_at=now() where id=$1`, [id]);
    await db.query(`select finish_notification_delivery($1,$2,'accepted','provider-id')`, [
      id,
      first.claim_token,
    ]);
    expect(await claim(id)).toBeUndefined();
    const r = await db.query<{ status: string; attempt_no: number }>(
      `select n.status,l.attempt_no from notifications n join notification_logs l on l.notification_id=n.id where n.id=$1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ status: 'read', attempt_no: 1 });
  });
  it('ログ保存が失敗したら受付状態の更新も戻り、送信権の期限後に回復できる', async () => {
    const id = await create();
    const first = await claim(id);
    await expect(
      db.query(`select finish_notification_delivery($1,$2,'accepted',repeat('x',129))`, [
        id,
        first.claim_token,
      ]),
    ).rejects.toThrow();
    const r = await db.query<{ state: string }>(
      `select state from notification_deliveries where notification_id=$1`,
      [id],
    );
    expect(r.rows[0].state).toBe('processing');
  });
  it('受信者は送信本文の固定データと送信RPCにアクセスできない', async () => {
    const id = await create();
    await claim(id);
    await db.asUser(fx.couple.authUserId, async () => {
      const r = await db.query(
        `select state,attempt_count from notification_deliveries where notification_id=$1`,
        [id],
      );
      expect(r.rows).toHaveLength(1);
      await expect(db.query(`select payload from notification_deliveries`)).rejects.toThrow();
      await expect(claim(id)).rejects.toThrow();
    });
  });
  it('同日でも別宿題は作成でき、同じ宿題・宛先・種別・JST日付はDBが重複を拒否する', async () => {
    const id = await create();
    await db.query(`update notifications set task_id=$1,event_on='2026-10-22' where id=$2`, [
      fx.taskId,
      id,
    ]);
    await expect(
      db.query(
        `insert into notifications (venue_id,case_id,recipient_user_id,channel,notification_type,title,body,task_id,event_on)
      select venue_id,case_id,recipient_user_id,channel,notification_type,title,body,task_id,event_on from notifications where id=$1`,
        [id],
      ),
    ).rejects.toThrow();
    await db.query(
      `insert into notifications (venue_id,case_id,recipient_user_id,channel,notification_type,title,body,task_id,event_on)
      select venue_id,case_id,recipient_user_id,channel,notification_type,title,body,task_id,event_on+1 from notifications where id=$1`,
      [id],
    );
    const otherTask = await db.query<{ id: string }>(
      `insert into case_tasks(case_id,title,due_date) values ($1,'別宿題',current_date) returning id`,
      [fx.caseId],
    );
    await db.query(
      `insert into notifications (venue_id,case_id,recipient_user_id,channel,notification_type,title,body,task_id,event_on)
      select venue_id,case_id,recipient_user_id,channel,notification_type,title,body,$2,event_on from notifications where id=$1`,
      [id, otherTask.rows[0].id],
    );
  });
  it('未構成ではLINE枠・試行数・再送窓を消費しない', async () => {
    await db.query(`update user_profiles set line_user_id='U123' where id=$1`, [
      fx.couple.profileId,
    ]);
    const id = await create('line');
    const r = await db.query(
      `select * from claim_notification_delivery($1,null,array['in_app']::text[])`,
      [id],
    );
    expect(r.rows).toHaveLength(0);
    const status = await db.query<{ attempt_count: number; first_requested_at: string | null }>(
      `select attempt_count,first_requested_at from notification_deliveries where notification_id=$1`,
      [id],
    );
    expect(status.rows[0]).toEqual({ attempt_count: 0, first_requested_at: null });
    const quota = await db.query(`select * from notification_quota_counters where scope_id=$1`, [
      fx.caseId,
    ]);
    expect(quota.rows).toHaveLength(0);
    await db.query(`update user_profiles set line_user_id=null where id=$1`, [fx.couple.profileId]);
  });
  it('結果不明後に設定が外れても試行数を増やさず、開始済みの再送期限は保持する', async () => {
    const id = await create();
    const first = await claim(id);
    await db.query(`select finish_notification_delivery($1,$2,'unknown',null)`, [
      id,
      first.claim_token,
    ]);
    await db.query(
      `update notification_deliveries set next_attempt_at=now()-interval '1 second' where notification_id=$1`,
      [id],
    );
    const before = await db.query<{ first_requested_at: Date }>(
      `select first_requested_at from notification_deliveries where notification_id=$1`,
      [id],
    );
    const result = await db.query(
      `select * from claim_notification_delivery($1,null,array['in_app']::text[])`,
      [id],
    );
    expect(result.rows).toHaveLength(0);
    const after = await db.query<{ attempt_count: number; first_requested_at: Date }>(
      `select attempt_count,first_requested_at from notification_deliveries where notification_id=$1`,
      [id],
    );
    expect(after.rows[0].attempt_count).toBe(1);
    expect(after.rows[0].first_requested_at).toEqual(before.rows[0].first_requested_at);
  });
  it('同じ手動送信の再実行は同じ通知IDを返し、内容のすり替えは拒否する', async () => {
    await db.asUser(fx.planner.authUserId, async () => {
      const sql = `select create_notification_once($1,$2,'email','info','件名',$3,'same-event') as id`;
      const a = await db.query<{ id: string }>(sql, [fx.caseId, fx.couple.profileId, '本文']);
      const b = await db.query<{ id: string }>(sql, [fx.caseId, fx.couple.profileId, '本文']);
      expect(a.rows[0].id).toBe(b.rows[0].id);
      await expect(db.query(sql, [fx.caseId, fx.couple.profileId, '変更'])).rejects.toThrow();
    });
  });
  it('旧版の外部通知の既読は受付済みと誤認せず、切替日の再生成を保留する', async () => {
    const legacy = await TestDb.create({
      beforeMigration: '20261022000100_notification_delivery.sql',
    });
    try {
      const old = await seedFixture(legacy);
      const rows = await legacy.query<{ id: string }>(
        `insert into notifications
        (venue_id,case_id,recipient_user_id,channel,notification_type,title,body,status)
        values ($1,$2,$3,'email','overdue','旧通知','本文','read'),
          ($1,$2,$3,'in_app','due_reminder','旧アプリ通知','本文','read') returning id`,
        [old.venueId, old.caseId, old.couple.profileId],
      );
      await legacy.pg.exec(
        readFileSync(
          join(process.cwd(), 'supabase/migrations/20261022000100_notification_delivery.sql'),
          'utf8',
        ),
      );
      const external = await legacy.query<{ state: string }>(
        `select state from notification_deliveries where notification_id=$1`,
        [rows.rows[0].id],
      );
      expect(external.rows[0].state).toBe('review');
      const inApp = await legacy.query<{ state: string }>(
        `select state from notification_deliveries where notification_id=$1`,
        [rows.rows[1].id],
      );
      expect(inApp.rows[0].state).toBe('sent');
      const guard = await legacy.query<{ blocked_reason: string }>(
        `select blocked_reason from notification_generation_runs`,
      );
      expect(guard.rows[0].blocked_reason).toBe('legacy_day_needs_review');
      expect((await legacy.query('select id from notifications')).rows).toHaveLength(2);
    } finally {
      await legacy.close();
    }
  });
});
