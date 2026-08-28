/**
 * 並行性の検証（実 PostgreSQL が必要）。
 *
 * 設計書 Version 1.2 が明示している「同時リクエストでも壊れない」性質を、
 * 実際に複数接続から同時に叩いて確かめる。
 * PGlite は単一接続なので、この観点だけは tests/db/harness.ts では検証できない。
 *
 *   - 6-6-1: 招待トークンの消費は「同一URLの同時2リクエストでも1つしか通らない」
 *   - 5-7  : case_code は UNIQUE 違反時に採番をやり直して再試行する
 *   - 5-3  : レート制限は insert ... on conflict do update returning で原子的に数える
 *   - 6-7  : 最新提出は case_task ごとに1件（部分ユニーク）
 *   - 6-7  : 提出・確認は単一トランザクション（同時確認で確定するのは1人だけ）
 *
 * 接続情報が無ければ skip する。CI と通常の開発は PGlite 側だけで完結する。
 *   set TEST_PG_URL=postgres://postgres:<pw>@127.0.0.1:5433/postgres
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTestDb, hasRealPg } from './pg-harness';

const d = describe.skipIf(!hasRealPg);

let db: PgTestDb;
let venueId: string;
let plannerAuthId: string;
let plannerProfileId: string;
let coupleAuthId: string;
let coupleProfileId: string;
let caseId: string;

beforeAll(async () => {
  if (!hasRealPg) return;
  db = await PgTestDb.create();

  await db.asOwner(async (q) => {
    const venue = await q(`select id from venues where code = 'BRIDAL01'`);
    venueId = venue.rows[0].id as string;

    const mkUser = async (role: string, email: string) => {
      const a = await q('insert into auth.users (email) values ($1) returning id', [email]);
      const authId = a.rows[0].id as string;
      const p = await q(
        `insert into user_profiles (auth_user_id, venue_id, role, display_name, email)
         values ($1, $2, $3, $4, $5) returning id`,
        [authId, venueId, role, email.split('@')[0], email]);
      return { authId, profileId: p.rows[0].id as string };
    };

    const planner = await mkUser('planner', 'c-planner@example.test');
    plannerAuthId = planner.authId;
    plannerProfileId = planner.profileId;
    const couple = await mkUser('couple', 'c-couple@example.test');
    coupleAuthId = couple.authId;
    coupleProfileId = couple.profileId;

    const plan = await q(
      'select id from plan_types where venue_id = $1 order by display_order limit 1', [venueId]);
    const c = await q(
      `insert into wedding_cases
         (venue_id, plan_type_id, primary_planner_id, case_code, wedding_date)
       values ($1, $2, $3, 'BRIDAL01-2026-9001', current_date + 120) returning id`,
      [venueId, plan.rows[0].id, plannerProfileId]);
    caseId = c.rows[0].id as string;

    await q(
      `insert into couple_profiles (case_id, user_profile_id, partner_role, full_name)
       values ($1, $2, 'groom', 'テスト太郎')`, [caseId, coupleProfileId]);
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

d('招待トークンの原子的な消費（6-6-1）', () => {
  it('同一トークンへ同時に8リクエストを投げても1つしか通らない', async () => {
    const tokenHash = 'concurrent-token-hash-1';
    await db.asOwner((q) =>
      q(`insert into case_invitations
           (case_id, invited_by, target_partner_role, token_hash, purpose, expires_at)
         values ($1, $2, 'bride', $3, 'initial_registration', now() + interval '14 days')`,
        [caseId, plannerProfileId, tokenHash]));

    // 8本の独立した接続から同時に消費を試みる
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.asOwner((q) =>
          q('select * from consume_invitation($1, $2)', [tokenHash, 'initial_registration'])
            .then((r) => r.rows.length)
            .catch(() => -1))),
    );

    const succeeded = attempts.filter((n) => n === 1).length;
    const empty = attempts.filter((n) => n === 0).length;
    expect(succeeded).toBe(1);
    expect(empty).toBe(7);

    const after = await db.asOwner((q) =>
      q('select use_count, used_at from case_invitations where token_hash = $1', [tokenHash]));
    expect(after.rows[0].use_count).toBe(1);
    expect(after.rows[0].used_at).not.toBeNull();
  }, 60_000);

  it('max_uses が複数のトークンでも上限を超えて消費されない', async () => {
    const tokenHash = 'concurrent-token-hash-2';
    await db.asOwner((q) =>
      q(`insert into case_invitations
           (case_id, invited_by, target_partner_role, token_hash, purpose, expires_at, max_uses)
         values ($1, $2, 'partner_a', $3, 'mypage_access', now() + interval '30 days', 5)`,
        [caseId, plannerProfileId, tokenHash]));

    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        db.asOwner((q) =>
          q('select * from consume_invitation($1, $2)', [tokenHash, 'mypage_access'])
            .then((r) => r.rows.length)
            .catch(() => -1))),
    );

    expect(attempts.filter((n) => n === 1).length).toBe(5);

    const after = await db.asOwner((q) =>
      q('select use_count, max_uses from case_invitations where token_hash = $1', [tokenHash]));
    expect(after.rows[0].use_count).toBe(5);
  }, 60_000);
});

d('レート制限の原子的インクリメント（5-3）', () => {
  it('同時に20回叩いても許可されるのは上限の回数だけ', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.asOwner((q) =>
          q(`select check_rate_limit('otp_request', 'concurrent-key', 3600, 5) as allowed`)
            .then((r) => r.rows[0].allowed as boolean))),
    );

    expect(results.filter(Boolean).length).toBe(5);
    expect(results.filter((r) => !r).length).toBe(15);

    const row = await db.asOwner((q) =>
      q(`select attempt_count from auth_rate_limits
          where key_type = 'otp_request' and key_hash = 'concurrent-key'`));
    expect(row.rows[0].attempt_count).toBe(20);
  }, 60_000);
});

d('案件番号の採番競合（5-7）', () => {
  it('同時に採番すると同じ番号を返しうるが、UNIQUE 制約が重複登録を止める', async () => {
    // next_case_code は stable な読み取りなので、同時実行では同じ値を返しうる。
    // 5-7 が「UNIQUE 違反時は採番をやり直して再試行」と定めているのは、この性質が前提。
    const codes = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.asOwner((q) =>
          q('select next_case_code($1, 2027) as code', [venueId])
            .then((r) => r.rows[0].code as string))),
    );
    expect(new Set(codes).size).toBeGreaterThanOrEqual(1);

    // 同じ番号で同時に登録を試みると、通るのは1件だけ
    const inserts = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.asOwner((q) =>
          q(`insert into wedding_cases
               (venue_id, plan_type_id, primary_planner_id, case_code, wedding_date)
             values ($1, null, $2, $3, current_date + 200) returning id`,
            [venueId, plannerProfileId, codes[0]])
            .then(() => 'ok')
            .catch((e: { code?: string }) => e.code ?? 'err'))),
    );
    expect(inserts.filter((r) => r === 'ok').length).toBe(1);
    expect(inserts.filter((r) => r === '23505').length).toBe(5);
  }, 60_000);
});

d('最新提出の一意性（6-7）', () => {
  it('同時に提出しても is_latest の行は1件に保たれる', async () => {
    const task = await db.asOwner((q) =>
      q(`insert into case_tasks (case_id, title, submission_format, due_date)
         values ($1, '同時提出テスト', 'text', current_date + 30) returning id`, [caseId]));
    const taskId = task.rows[0].id as string;

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        db.asUser(coupleAuthId, (q) =>
          q(`insert into task_submissions
               (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
             values ($1, $2, 'text', $3, 'submitted', true) returning id`,
            [taskId, coupleProfileId, `v${i}`])
            .then(() => 'ok')
            .catch((e: { code?: string }) => e.code ?? 'err'))),
    );

    expect(results.filter((r) => r === 'ok').length).toBe(1);
    expect(results.filter((r) => r === '23505').length).toBe(7);

    const latest = await db.asOwner((q) =>
      q('select count(*)::int as n from task_submissions where case_task_id = $1 and is_latest',
        [taskId]));
    expect(latest.rows[0].n).toBe(1);
  }, 60_000);
});

d('RLS が同時接続でも効く', () => {
  it('別々の接続で別のロールを名乗っても、互いのスコープが混ざらない', async () => {
    const [asPlanner, asCouple, asAnon] = await Promise.all([
      db.asUser(plannerAuthId, (q) => q('select id from wedding_cases').then((r) => r.rows.length)),
      db.asUser(coupleAuthId, (q) => q('select id from wedding_cases').then((r) => r.rows.length)),
      db.asUser(null, (q) => q('select id from wedding_cases').then((r) => r.rows.length)),
    ]);

    // planner は自担当（採番競合テストで作った分を含む）、couple は1件、未認証は0件
    expect(asPlanner).toBeGreaterThanOrEqual(1);
    expect(asCouple).toBe(1);
    expect(asAnon).toBe(0);
  }, 60_000);
});

d('LINE送信上限の競合（6-9）', () => {
  it('同時に10通ぶん確保しても、案件×週の上限を超えて true を返さない', async () => {
    const c = await db.asOwner((q) =>
      q(`insert into wedding_cases
           (venue_id, plan_type_id, primary_planner_id, case_code, wedding_date)
         values ($1, null, $2, 'BRIDAL01-2026-9101', current_date + 150) returning id`,
        [venueId, plannerProfileId]));
    const quotaCaseId = c.rows[0].id as string;

    // 既定は案件あたり週1通（6-9）。同時に叩いても1つだけが true になる。
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.asOwner((q) =>
          q('select claim_line_quota($1, $2) as allowed', [quotaCaseId, venueId])
            .then((r) => r.rows[0].allowed as boolean))),
    );

    expect(results.filter(Boolean).length).toBe(1);

    const counter = await db.asOwner((q) =>
      q(`select sent_count from notification_quota_counters
          where scope = 'case_week' and scope_id = $1`, [quotaCaseId]));
    // 上限超過ぶんはサブトランザクションで巻き戻るので、カウンタは上限のまま
    expect(counter.rows[0].sent_count).toBe(1);
  }, 60_000);

  it('式場の月枠も、同時実行で上限を超えて配られない', async () => {
    const v = await db.asOwner((q) =>
      q(`insert into venues (name, code) values ('並行テスト式場', 'CONC01') returning id`));
    const quotaVenueId = v.rows[0].id as string;

    await db.asOwner((q) =>
      q(`insert into notification_settings
           (venue_id, line_per_case_per_week, line_per_venue_per_month)
         values ($1, 99, 3)`, [quotaVenueId]));

    // 案件側の枠は 99 なので、律速は式場の月3通
    const cases: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const c = await db.asOwner((q) =>
        q(`insert into wedding_cases
             (venue_id, plan_type_id, primary_planner_id, case_code, wedding_date)
           values ($1, null, $2, $3, current_date + 150) returning id`,
          [quotaVenueId, plannerProfileId, `CONC01-2026-${String(i).padStart(4, '0')}`]));
      cases.push(c.rows[0].id as string);
    }

    const results = await Promise.all(
      cases.map((id) =>
        db.asOwner((q) =>
          q('select claim_line_quota($1, $2) as allowed', [id, quotaVenueId])
            .then((r) => r.rows[0].allowed as boolean))),
    );

    expect(results.filter(Boolean).length).toBe(3);

    const counter = await db.asOwner((q) =>
      q(`select sent_count from notification_quota_counters
          where scope = 'venue_month' and scope_id = $1`, [quotaVenueId]));
    expect(counter.rows[0].sent_count).toBe(3);
  }, 60_000);
});

d('AIジョブの二重取得防止（7-3 for update skip locked）', () => {
  it('10ワーカーが同時に取りにきても、同じジョブを2度掴まない', async () => {
    // 5件のジョブを積み、10本の接続から同時に取得を試みる
    await db.asOwner(async (q) => {
      for (let i = 0; i < 5; i += 1) {
        await q(
          `insert into ai_jobs (venue_id, case_id, job_type, input_ref, status)
           values ($1, $2, 'classification', $3::jsonb, 'queued')`,
          [venueId, caseId, JSON.stringify({ params: {}, text: `sample ${i}` })]);
      }
    });

    const claimed = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.asOwner((q) =>
          q('select id from claim_ai_job($1, null)', [`worker-${i}`])
            .then((r) => (r.rows[0]?.id as string | undefined) ?? null))),
    );

    const got = claimed.filter((id): id is string => id !== null);
    // 5件しか無いので、掴めるのは5本まで
    expect(got.length).toBe(5);
    // 同じジョブを2人が掴んでいない
    expect(new Set(got).size).toBe(5);

    const processing = await db.asOwner((q) =>
      q(`select count(*)::int as n from ai_jobs where status = 'processing'`));
    expect(processing.rows[0].n).toBe(5);
  }, 60_000);

  it('掴んだワーカー以外は結果を書き込めない（滞留回収後の遅れた書き込みを防ぐ）', async () => {
    const job = await db.asOwner((q) =>
      q(`insert into ai_jobs (venue_id, case_id, job_type, input_ref, status)
         values ($1, $2, 'draft', '{}'::jsonb, 'queued') returning id`, [venueId, caseId]));
    const jobId = job.rows[0].id as string;

    await db.asOwner((q) => q('select id from claim_ai_job($1, null)', ['worker-A']));

    const byOther = await db.asOwner((q) =>
      q('select complete_ai_job($1, $2, $3::jsonb, null, null) as ok',
        [jobId, 'worker-B', JSON.stringify({ text: 'x', cautions: [] })]));
    expect(byOther.rows[0].ok).toBe(false);
  }, 60_000);
});

d('提出・確認の単一トランザクション（6-7、20260828002100）', () => {
  it('同時に提出しても最新は1件で、宿題の状態もずれない', async () => {
    const task = await db.asOwner((q) =>
      q(`insert into case_tasks (case_id, title, submission_format, due_date)
         values ($1, '同時提出（関数経由）', 'text', current_date + 30) returning id`, [caseId]));
    const taskId = task.rows[0].id as string;

    // 素の insert（上の「最新提出の一意性」）は 23505 になるのが正しい挙動だが、
    // 関数経由では未レビュー提出を上書きするため、全部が成功しても構わない。
    // 壊れてはいけないのは「最新が1件」「case_tasks が submitted」の2点。
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        db.asUser(coupleAuthId, (q) =>
          q('select * from submit_task_atomic($1, $2, $3, null, null, null, false)',
            [taskId, 'text', `v${i}`])
            .then(() => 'ok')
            .catch((e: { code?: string }) => e.code ?? 'err'))),
    );
    // 同時実行でぶつかったものは 409／23505 になりうる。1つも通らないのは異常。
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThanOrEqual(1);

    const state = await db.asOwner((q) =>
      q(`select (select count(*)::int from task_submissions
                  where case_task_id = $1 and is_latest) as latest,
                (select status from case_tasks where id = $1) as status`, [taskId]));
    expect(state.rows[0].latest).toBe(1);
    expect(state.rows[0].status).toBe('submitted');
  }, 60_000);

  it('2人が同時に確認しても、確定するのは1人だけ', async () => {
    const setup = await db.asOwner(async (q) => {
      const t = await q(
        `insert into case_tasks (case_id, title, submission_format, due_date, status)
         values ($1, '同時確認', 'text', current_date + 30, 'submitted') returning id`, [caseId]);
      const s = await q(
        `insert into task_submissions
           (case_task_id, submitted_by, submission_type, text_value, review_status, is_latest)
         values ($1, $2, 'text', '内容', 'submitted', true) returning id`,
        [t.rows[0].id, coupleProfileId]);
      return { taskId: t.rows[0].id as string, submissionId: s.rows[0].id as string };
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        db.asUser(plannerAuthId, (q) =>
          q('select * from review_submission($1, $2, $3)',
            [setup.submissionId, i % 2 === 0 ? 'confirmed' : 'needs_fix', null])
            .then(() => 'ok')
            .catch((e: { code?: string }) => e.code ?? 'err'))),
    );

    // review_status='submitted' を更新条件に含めているので、勝つのは1つだけ
    expect(results.filter((r) => r === 'ok').length).toBe(1);

    // 提出と宿題が同じ結論になっていること（分けていたときに壊れうった不変条件）
    const after = await db.asOwner((q) =>
      q(`select s.review_status, t.status
           from task_submissions s join case_tasks t on t.id = s.case_task_id
          where s.id = $1`, [setup.submissionId]));
    expect(after.rows[0].status).toBe(after.rows[0].review_status);
  }, 60_000);
});
