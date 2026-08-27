/**
 * 宿題の状態遷移ガード（機能5-5 / 6-6-2）。
 *
 * 20260828001100_task_state_guards.sql で update_case_task に入れたガードを検証する。
 * 実装レビューで「提出済み・確認済みの宿題に waived を付けて解除すると not_started へ
 * 巻き戻り、確認実績が状態から消える」ことが判明したため、退行しないよう固定する。
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

/** 例外の SQLSTATE と message を取り出す。 */
async function errorOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? 'unknown', message: e.message ?? '' };
  }
}

/** 指定の状態で宿題を1件作る。 */
async function makeTask(status: string): Promise<string> {
  const r = await db.asOwner(() =>
    db.query<{ id: string }>(
      `insert into case_tasks (case_id, title, submission_format, due_date, status)
       values ($1, $2, 'text', current_date + 30, $3) returning id`,
      [fx.caseId, `宿題(${status})`, status]));
  return r.rows[0].id;
}

const statusOf = async (taskId: string) => {
  const r = await db.asOwner(() =>
    db.query<{ status: string }>('select status from case_tasks where id = $1', [taskId]));
  return r.rows[0].status;
};

describe('対応不要（waived）の付与', () => {
  it('未着手の宿題には付与できる', async () => {
    const taskId = await makeTask('not_started');
    await db.asUser(fx.planner.authUserId, () =>
      db.query('select update_case_task($1, $2::jsonb)', [taskId, JSON.stringify({ waived: true })]));
    expect(await statusOf(taskId)).toBe('waived');
  });

  it('既に waived の宿題への再付与は受け付ける（画面の二重送信を落とさない）', async () => {
    const taskId = await makeTask('waived');
    await db.asUser(fx.planner.authUserId, () =>
      db.query('select update_case_task($1, $2::jsonb)', [taskId, JSON.stringify({ waived: true })]));
    expect(await statusOf(taskId)).toBe('waived');
  });

  it.each(['submitted', 'needs_fix', 'confirmed'])(
    '%s の宿題には付与できない（提出・確認の実績を消さない）',
    async (status) => {
      const taskId = await makeTask(status);
      const error = await db.asUser(fx.planner.authUserId, () =>
        errorOf(() =>
          db.query('select update_case_task($1, $2::jsonb)',
            [taskId, JSON.stringify({ waived: true })])));
      expect(error?.code).toBe('BH422');
      // message はそのまま画面へ出るため、内部IDや status の生値を含めない
      expect(error?.message).toContain('対応不要');
      expect(error?.message).not.toContain(taskId);
      expect(await statusOf(taskId)).toBe(status);
    },
  );
});

describe('対応不要の解除', () => {
  it('waived からは未着手へ戻せる', async () => {
    const taskId = await makeTask('waived');
    await db.asUser(fx.planner.authUserId, () =>
      db.query('select update_case_task($1, $2::jsonb)', [taskId, JSON.stringify({ waived: false })]));
    expect(await statusOf(taskId)).toBe('not_started');
  });

  it.each(['submitted', 'confirmed'])(
    '%s の宿題を解除で not_started へ巻き戻せない',
    async (status) => {
      const taskId = await makeTask(status);
      const error = await db.asUser(fx.planner.authUserId, () =>
        errorOf(() =>
          db.query('select update_case_task($1, $2::jsonb)',
            [taskId, JSON.stringify({ waived: false })])));
      expect(error?.code).toBe('BH422');
      expect(await statusOf(taskId)).toBe(status);
    },
  );
});

describe('waived を指定しない更新', () => {
  it('期限だけを変えても状態は動かない', async () => {
    const taskId = await makeTask('confirmed');
    await db.asUser(fx.planner.authUserId, () =>
      db.query('select update_case_task($1, $2::jsonb)',
        [taskId, JSON.stringify({ due_date: '2026-12-01' })]));
    expect(await statusOf(taskId)).toBe('confirmed');
    // PGlite は date を JS の Date として返すため、比較は SQL 側で text に寄せる
    const r = await db.asOwner(() =>
      db.query<{ due_date: string }>(
        `select to_char(due_date, 'YYYY-MM-DD') as due_date from case_tasks where id = $1`,
        [taskId]));
    expect(r.rows[0].due_date).toBe('2026-12-01');
  });

  it('waived:null は「指定なし」として扱う（偽側へ落ちて巻き戻さない）', async () => {
    const taskId = await makeTask('confirmed');
    await db.asUser(fx.planner.authUserId, () =>
      db.query('select update_case_task($1, $2::jsonb)',
        [taskId, JSON.stringify({ waived: null, title: '改題' })]));
    expect(await statusOf(taskId)).toBe('confirmed');
  });
});

describe('権限', () => {
  it('couple は update_case_task を呼べない（機能5-5 は planner／admin の操作）', async () => {
    const taskId = await makeTask('not_started');
    const error = await db.asUser(fx.couple.authUserId, () =>
      errorOf(() =>
        db.query('select update_case_task($1, $2::jsonb)',
          [taskId, JSON.stringify({ waived: true })])));
    expect(error?.code).toBe('42501');
    expect(await statusOf(taskId)).toBe('not_started');
  });

  it('他式場の admin は呼べない', async () => {
    const taskId = await makeTask('not_started');
    const error = await db.asUser(fx.otherVenueAdmin.authUserId, () =>
      errorOf(() =>
        db.query('select update_case_task($1, $2::jsonb)',
          [taskId, JSON.stringify({ waived: true })])));
    expect(error?.code).toBe('42501');
  });
});
