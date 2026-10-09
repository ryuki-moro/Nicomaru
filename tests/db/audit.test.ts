import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestDb, seedFixture, type Fixture } from './harness';

let db: TestDb;
let fx: Fixture;
beforeAll(async () => {
  db = await TestDb.create();
  fx = await seedFixture(db);
});
beforeEach(async () => {
  await db.asOwner(() => db.pg.exec('delete from audit_logs; delete from auth_rate_limits'));
});
afterAll(async () => {
  await db?.close();
});

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  return db.asOwner(async () => {
    await db.query('set role service_role');
    try {
      return await fn();
    } finally {
      await db.query('reset role');
    }
  });
}
async function audits() {
  return (
    await db.asOwner(() =>
      db.query<{
        actor_user_id: string | null;
        action: string;
        target_type: string;
        target_id: string;
        detail_json: Record<string, unknown>;
      }>(
        'select actor_user_id,action,target_type,target_id,detail_json from audit_logs order by created_at,id',
      ),
    )
  ).rows;
}

describe('管理操作の監査', () => {
  it('テンプレート更新は同じtransactionで実行者と変更列だけを記録する', async () => {
    await db.asUser(fx.admin.authUserId, () =>
      db.query(
        `update task_templates set description='secret name/address/email', active=false where venue_id=$1`,
        [fx.venueId],
      ),
    );
    const rows = await audits();
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (r) => r.actor_user_id === fx.admin.profileId && r.action === 'task_template.update',
      ),
    ).toBe(true);
    expect(rows[0].detail_json).toEqual({ changed: ['active', 'description'] });
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('変更のないUPDATEは記録しない', async () => {
    await db.asUser(fx.admin.authUserId, () =>
      db.query('update task_templates set name=name where venue_id=$1', [fx.venueId]),
    );
    expect(await audits()).toHaveLength(0);
  });

  it('他式場またはplannerによる拒否された更新には成功ログを残さない', async () => {
    await db.asUser(fx.otherVenueAdmin.authUserId, () =>
      db.query('update task_templates set active=true where venue_id=$1', [fx.venueId]),
    );
    await db.asUser(fx.planner.authUserId, () =>
      db.query('update task_templates set active=true where venue_id=$1', [fx.venueId]),
    );
    expect(await audits()).toHaveLength(0);
  });

  it('リスクルール有効切替を記録し条件本文は複写しない', async () => {
    await db.asUser(fx.systemAdmin.authUserId, () =>
      db.query('update risk_rules set active=not active'),
    );
    const rows = await audits();
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (r) =>
          r.action === 'risk_rule.update' &&
          JSON.stringify(r.detail_json) === '{"changed":["active"]}',
      ),
    ).toBe(true);
  });

  it('プラン種別/割当のINSERT・DELETEを記録する', async () => {
    await db.asUser(fx.admin.authUserId, async () => {
      const inserted = await db.query<{ id: string }>(
        `insert into plan_types(venue_id,name) values($1,'private plan') returning id`,
        [fx.venueId],
      );
      await db.query('delete from plan_types where id=$1', [inserted.rows[0].id]);
    });
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['plan_type.insert', 'plan_type.delete']);
    expect(JSON.stringify(rows)).not.toContain('private plan');
  });

  it('担当プランナー変更は対象案件IDと変更列だけを記録する', async () => {
    await db.asUser(fx.admin.authUserId, () =>
      db.query('update wedding_cases set primary_planner_id=$1 where id=$2', [
        fx.otherPlanner.profileId,
        fx.caseId,
      ]),
    );
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'case.planner_changed',
      target_id: fx.caseId,
      actor_user_id: fx.admin.profileId,
      detail_json: { changed: ['primary_planner_id'] },
    });
  });

  it('ロール変更は操作本人を記録し、停止中や他の利用者へactorを置き換えない', async () => {
    await db.asUser(fx.systemAdmin.authUserId, () =>
      db.query(`update user_profiles set role='admin' where id=$1`, [
        fx.suspendedPlanner.profileId,
      ]),
    );
    expect((await audits())[0]).toMatchObject({
      action: 'user.role_changed',
      actor_user_id: fx.systemAdmin.profileId,
      target_id: fx.suspendedPlanner.profileId,
      detail_json: { changed: ['role'] },
    });
  });

  it('式場作成は連絡先の値を記録しない', async () => {
    await db.asUser(fx.systemAdmin.authUserId, () =>
      db.query(
        `insert into venues(name,code,contact_email) values('private name','AUDITVENUE','private@example.test')`,
      ),
    );
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'venue.insert',
      actor_user_id: fx.systemAdmin.profileId,
    });
    expect(JSON.stringify(rows)).not.toContain('private');
  });

  it('管理者の通常確認に伴う宿題status更新は二重記録しない', async () => {
    await db.asUser(fx.admin.authUserId, () =>
      db.query(`update case_tasks set status='not_started' where id=$1`, [fx.taskId]),
    );
    expect(await audits()).toHaveLength(0);
  });

  it('監査挿入が失敗したら元の管理更新もロールバックされる', async () => {
    await db.asOwner(() =>
      db.pg
        .exec(`create function reject_test_audit() returns trigger language plpgsql as $$ begin raise exception 'test audit failure'; end $$;
      create trigger reject_test_audit before insert on audit_logs for each row execute function reject_test_audit()`),
    );
    try {
      await expect(
        db.asUser(fx.admin.authUserId, () =>
          db.query(`update task_templates set description='not committed' where venue_id=$1`, [
            fx.venueId,
          ]),
        ),
      ).rejects.toThrow('test audit failure');
      const result = await db.asOwner(() =>
        db.query(`select count(*)::int as n from task_templates where description='not committed'`),
      );
      expect(result.rows[0].n).toBe(0);
    } finally {
      await db.asOwner(() =>
        db.pg.exec(
          'drop trigger reject_test_audit on audit_logs; drop function reject_test_audit()',
        ),
      );
    }
  });
});

describe('認証イベントの固定RPC', () => {
  const hash = 'a'.repeat(64);
  it('9件では記録せず、password/OTP合算10件で1回だけ記録する', async () => {
    for (let i = 0; i < 9; i++)
      await asService(() => db.query(`select record_auth_failure($1,'password')`, [hash]));
    expect(await audits()).toHaveLength(0);
    await asService(() => db.query(`select record_auth_failure($1,'otp')`, [hash]));
    await asService(() => db.query(`select record_auth_failure($1,'password')`, [hash]));
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: null,
      action: 'auth.login_failures',
      target_type: 'auth',
      detail_json: { account_hash: hash, method: 'otp', count: 10, window_seconds: 3600 },
    });
  });

  it('正時をまたいだ直近1時間を合算し、1時間より前の失敗は数えない', async () => {
    await db.asOwner(() =>
      db.query(
        `insert into auth_rate_limits(key_type,key_hash,window_start,attempt_count) values
      ('login_failure',$1,clock_timestamp()-interval '59 minutes',5),
      ('login_failure',$1,clock_timestamp()-interval '10 minutes',4),
      ('login_failure',$1,clock_timestamp()-interval '61 minutes',50)`,
        [hash],
      ),
    );
    const r = await asService(() =>
      db.query<{ n: number }>(`select record_auth_failure($1,'password') as n`, [hash]),
    );
    expect(r.rows[0].n).toBe(10);
    expect(await audits()).toHaveLength(1);
  });

  it('別アカウントの失敗は合算しない', async () => {
    await db.asOwner(() =>
      db.query(
        `insert into auth_rate_limits(key_type,key_hash,window_start,attempt_count)
      values ('login_failure',$1,clock_timestamp(),9)`,
        [hash],
      ),
    );
    await asService(() => db.query(`select record_auth_failure($1,'password')`, ['b'.repeat(64)]));
    expect(await audits()).toHaveLength(0);
  });

  it('authenticated/anonから未認証イベントの投入はできない', async () => {
    await expect(
      db.asUser(fx.systemAdmin.authUserId, () =>
        db.query(`select record_auth_failure($1,'password')`, [hash]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.asUser(fx.systemAdmin.authUserId, () =>
        db.query('select record_password_reset_request()'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await db.asOwner(async () => {
      await db.query('set role anon');
      try {
        await expect(db.query('select record_password_reset_request()')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await db.query('reset role');
      }
    });
  });

  it('不正なhashや任意methodを保存しない', async () => {
    await expect(
      asService(() =>
        db.query(`select record_auth_failure('plain-email@example.test','password')`),
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      asService(() => db.query(`select record_auth_failure($1,'arbitrary')`, [hash])),
    ).rejects.toMatchObject({ code: '22023' });
    expect(await audits()).toHaveLength(0);
  });

  it('再設定要求の記録はアカウント情報を持たない', async () => {
    await asService(() => db.query('select record_password_reset_request()'));
    expect((await audits())[0]).toMatchObject({
      actor_user_id: null,
      target_id: null,
      action: 'auth.password_reset_requested',
      detail_json: {},
    });
  });

  it('パスワード更新イベントのactor/targetは本人に固定しcoupleを拒否する', async () => {
    await db.asUser(fx.planner.authUserId, () => db.query('select audit_password_changed()'));
    expect((await audits())[0]).toMatchObject({
      actor_user_id: fx.planner.profileId,
      target_id: fx.planner.profileId,
      action: 'auth.password_changed',
      detail_json: {},
    });
    await expect(
      db.asUser(fx.couple.authUserId, () => db.query('select audit_password_changed()')),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('監査ログの2暦年保持', () => {
  it.each([
    ['2028-02-29T12:34:56Z', '2026-02-28T12:34:56.000Z'],
    ['2026-03-01T00:00:00Z', '2024-03-01T00:00:00.000Z'],
    ['2026-01-01T00:00:00Z', '2024-01-01T00:00:00.000Z'],
  ])('UTC暦で%sから2年を引く', async (input, expected) => {
    const r = await db.asOwner(() =>
      db.query<{ cutoff: Date }>('select audit_retention_cutoff($1::timestamptz) as cutoff', [
        input,
      ]),
    );
    expect(new Date(r.rows[0].cutoff).toISOString()).toBe(expected);
  });

  it('閾値より前だけ削除し、同時刻・新しいログを保持し、再実行は0件', async () => {
    await db.asOwner(async () => {
      await db.query('begin');
      try {
        await db.query(`insert into audit_logs(action,target_type,created_at) values
          ('old','test',audit_retention_cutoff(now())-interval '1 microsecond'),
          ('boundary','test',audit_retention_cutoff(now())),('new','test',now())`);
        await db.query('set role service_role');
        const first = await db.query<{ deleted_count: number }>(
          'select * from purge_expired_audit_logs()',
        );
        const next = await db.query<{ deleted_count: number }>(
          'select * from purge_expired_audit_logs()',
        );
        expect(Number(first.rows[0].deleted_count)).toBe(1);
        expect(Number(next.rows[0].deleted_count)).toBe(0);
        await db.query('reset role');
        const left = await db.query<{ action: string }>(
          'select action from audit_logs order by created_at',
        );
        expect(left.rows.map((r) => r.action)).toEqual(['boundary', 'new']);
      } finally {
        await db.query('rollback');
      }
    });
  });

  it('system_adminを含むauthenticatedは削除RPCを実行できない', async () => {
    await expect(
      db.asUser(fx.systemAdmin.authUserId, () => db.query('select purge_expired_audit_logs()')),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
