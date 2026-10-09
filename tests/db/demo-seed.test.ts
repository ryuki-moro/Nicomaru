/**
 * 模擬データの投入（scripts/demo、Issue #24）。
 *
 * デモ・テストで使う状態（期限切れ・確認待ち・不備あり・未登録）が、
 * アプリと同じ DB 関数と同じ権限で作れることを、本番と同じマイグレーションの上で確かめる。
 * ここが通っていれば、ローカル Supabase／共有デモ環境に流しても同じ状態になる。
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decryptPii } from '@/lib/crypto';

import { DEMO_CASES, demoEmails } from '../../scripts/demo/scenario';
import { addDays, resetDemo, seedDemo, type DemoAuth, type SeedResult } from '../../scripts/demo/seed';
import { TestDb } from './harness';

const TODAY = '2026-11-01';
const BASE_URL = 'http://127.0.0.1:3000';

let db: TestDb;
let first: SeedResult;

/** Admin API の代わりに auth.users のスタブへ入れる。同じメールなら同じIDを返す */
function stubAuth(target: TestDb): DemoAuth {
  return {
    async ensureUser(email) {
      return target.asOwner(async () => {
        const found = await target.query<{ id: string }>('select id from auth.users where email = $1', [email]);
        if (found.rows[0]) return found.rows[0].id;
        const created = await target.query<{ id: string }>(
          'insert into auth.users (email) values ($1) returning id',
          [email],
        );
        return created.rows[0].id;
      });
    },
  };
}

const options = { plannerPassword: 'unused-in-test', today: TODAY, appBaseUrl: BASE_URL };

async function caseIdOf(key: string): Promise<string> {
  const res = await db.asOwner(() =>
    db.query<{ id: string }>('select id from wedding_cases where notes like $1', [`[demo:${key}]%`]),
  );
  return res.rows[0].id;
}

async function taskStatuses(key: string): Promise<Record<string, string>> {
  const caseId = await caseIdOf(key);
  const res = await db.asOwner(() =>
    db.query<{ title: string; status: string }>(
      'select title, status from case_tasks where case_id = $1',
      [caseId],
    ),
  );
  return Object.fromEntries(res.rows.map((r) => [r.title, r.status]));
}

beforeAll(async () => {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.PII_HMAC_KEY = randomBytes(32).toString('base64');
  db = await TestDb.create();
  first = await seedDemo(db, stubAuth(db), options);
});

afterAll(async () => {
  await db?.close();
});

describe('模擬データの中身', () => {
  it('メールアドレスはすべて予約TLD .test（外部へ届かない）', () => {
    for (const email of demoEmails()) expect(email).toMatch(/\.test$/);
  });

  it('シナリオの案件がすべて作られ、挙式日は「今日」から数えた日付になる', () => {
    expect(first.created.map((c) => c.key)).toEqual(DEMO_CASES.map((c) => c.key));
    expect(first.skipped).toEqual([]);
    for (const demo of DEMO_CASES) {
      const seeded = first.created.find((c) => c.key === demo.key)!;
      expect(seeded.weddingDate).toBe(addDays(TODAY, demo.daysUntilWedding));
      expect(seeded.caseCode).toMatch(/^BRIDAL01-/);
    }
  });

  it('氏名は暗号化して保存される（平文で DB に残らない）', async () => {
    const res = await db.asOwner(() =>
      db.query<{ full_name: string }>(
        `select cp.full_name from couple_profiles cp
           join wedding_cases wc on wc.id = cp.case_id
          where wc.notes like '[demo:demo-01]%' and cp.partner_role = 'bride'`,
      ),
    );
    expect(res.rows[0].full_name).not.toContain('青木');
    expect(decryptPii(res.rows[0].full_name)).toBe('青木 美咲');
  });

  it('未登録の側には招待URLが返り、登録済みの側には返らない', () => {
    const demo01 = first.created.find((c) => c.key === 'demo-01')!;
    expect(demo01.pendingInviteUrls.map((u) => u.partnerRole)).toEqual(['groom']);
    expect(demo01.pendingInviteUrls[0].url).toMatch(new RegExp(`^${BASE_URL}/register/[A-Za-z0-9_-]+$`));
    const demo05 = first.created.find((c) => c.key === 'demo-05')!;
    expect(demo05.pendingInviteUrls).toHaveLength(2);
    expect(demo05.registeredEmails).toEqual([]);
  });
});

describe('デモで見せる状態', () => {
  it('demo-01: 挙式が近く、重要な宿題が期限切れのまま残る', async () => {
    const caseId = await caseIdOf('demo-01');
    const overdue = await db.asOwner(() =>
      db.query<{ n: number }>(
        `select count(*)::int as n from case_tasks
          where case_id = $1 and status = 'not_started' and due_date < $2::date
            and importance in ('important', 'critical')`,
        [caseId, TODAY],
      ),
    );
    expect(overdue.rows[0].n).toBeGreaterThan(0);
    const statuses = await taskStatuses('demo-01');
    expect(statuses['料理コースの選択']).toBe('confirmed');
    expect(statuses['BGMリクエスト']).toBe('submitted');
  });

  it('demo-02: 不備あり・確認待ち・確認済みが1件ずつある', async () => {
    const statuses = await taskStatuses('demo-02');
    expect(statuses['BGMリクエスト']).toBe('needs_fix');
    expect(statuses['料理コースの選択']).toBe('submitted');
    expect(statuses['引き出物の選択']).toBe('confirmed');
  });

  it('demo-05: 新郎新婦が未登録で、提出は無い', async () => {
    const caseId = await caseIdOf('demo-05');
    const linked = await db.asOwner(() =>
      db.query<{ n: number }>(
        'select count(*)::int as n from couple_profiles where case_id = $1 and user_profile_id is not null',
        [caseId],
      ),
    );
    expect(linked.rows[0].n).toBe(0);
  });

  it('新郎新婦は自分の案件だけを見られる（RLS がそのまま効いている）', async () => {
    const auth = await db.asOwner(() =>
      db.query<{ id: string }>('select id from auth.users where email = $1', [DEMO_CASES[1].groom.email]),
    );
    const visible = await db.asUser(auth.rows[0].id, () =>
      db.query<{ notes: string | null; id: string }>('select id from wedding_cases'),
    );
    expect(visible.rows.map((r) => r.id)).toEqual([await caseIdOf('demo-02')]);
  });
});

describe('作り直し', () => {
  it('もう一度流しても重複して作らない', async () => {
    const again = await seedDemo(db, stubAuth(db), options);
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual(DEMO_CASES.map((c) => c.key));
  });

  it('--reset で目印つきの案件だけを消し、同じアカウントで作り直せる', async () => {
    const other = await db.asOwner(() =>
      db.query<{ id: string }>(
        `insert into wedding_cases (venue_id, primary_planner_id, case_code, wedding_date, notes)
         select venue_id, id, 'BRIDAL01-2099-9999', current_date + 30, 'デモ以外の案件'
           from user_profiles where email = 'planner@nicomaru.test' returning id`,
      ),
    );

    expect(await resetDemo(db)).toBe(DEMO_CASES.length);

    const remaining = await db.asOwner(() =>
      db.query<{ id: string }>('select id from wedding_cases where id = $1', [other.rows[0].id]),
    );
    expect(remaining.rows).toHaveLength(1);

    const users = await db.asOwner(() => db.query<{ n: number }>('select count(*)::int as n from auth.users'));
    const recreated = await seedDemo(db, stubAuth(db), { ...options, today: '2026-12-01' });
    expect(recreated.created).toHaveLength(DEMO_CASES.length);
    expect(recreated.created[0].weddingDate).toBe(addDays('2026-12-01', DEMO_CASES[0].daysUntilWedding));

    // アカウントは使い回すので増えない
    const usersAfter = await db.asOwner(() => db.query<{ n: number }>('select count(*)::int as n from auth.users'));
    expect(usersAfter.rows[0].n).toBe(users.rows[0].n);
  });
});
