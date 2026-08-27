/**
 * PGlite（WASM PostgreSQL）上に本番と同じマイグレーションを流し、RLS を実データで検証するための土台。
 *
 * 第11章「RLSテスト」の合格基準をCIで機械検証するために用いる（12-2「RLSテストの自動化」）。
 * Docker / Supabase CLI を必要としないので、CI と開発機の両方で同じテストが動く。
 *
 * Supabase 固有の前提のうち、テストに必要なものだけをスタブする:
 *   - auth.users テーブル（user_profiles.auth_user_id の参照先）
 *   - auth.uid()（JWT の sub クレームを返す。Supabase の実装と同じく GUC から読む）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const SEED_PATH = join(process.cwd(), 'supabase', 'seed.sql');

/** Supabase 側が提供する前提のオブジェクト。マイグレーションより先に作る。 */
const SUPABASE_STUB = `
create schema if not exists auth;
create schema if not exists extensions;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Supabase の auth.uid() と同じく、リクエストの JWT クレームから読む。
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Supabase 本番と同じ権限。auth.users 自体は authenticated から読めない。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

export type Role = 'couple' | 'planner' | 'admin' | 'system_admin';

export interface SeededUser {
  authUserId: string;
  profileId: string;
  role: Role;
  venueId: string | null;
}

export class TestDb {
  private constructor(readonly pg: PGlite) {}

  static async create(options: { seed?: boolean } = {}): Promise<TestDb> {
    // Supabase では既定で有効な pgcrypto を PGlite にも読み込ませる
    const pg = new PGlite({ extensions: { pgcrypto } });
    await pg.exec(SUPABASE_STUB);

    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await pg.exec(sql);
      } catch (error) {
        throw new Error(`migration failed: ${file}\n${(error as Error).message}`);
      }
    }

    if (options.seed !== false) {
      await pg.exec(readFileSync(SEED_PATH, 'utf8'));
    }
    return new TestDb(pg);
  }

  /** RLS を回避できる所有者権限で実行する（セットアップ・検証用）。 */
  async asOwner<T>(fn: () => Promise<T>): Promise<T> {
    await this.pg.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    return fn();
  }

  /**
   * authenticated ロール＋指定ユーザーの JWT で実行する。
   * テーブル所有者は RLS をバイパスするため、必ずロールを切り替えてから検証する。
   */
  async asUser<T>(authUserId: string | null, fn: () => Promise<T>): Promise<T> {
    await this.pg.exec(`
      reset role;
      select set_config('request.jwt.claim.sub', ${authUserId ? `'${authUserId}'` : "''"}, false);
      set role authenticated;
    `);
    try {
      return await fn();
    } finally {
      await this.pg.exec('reset role;');
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.pg.query<T>(sql, params);
  }

  async close() {
    await this.pg.close();
  }
}

/** venue / planner / admin / couple を一式そろえたテスト用のデータセット。 */
export interface Fixture {
  venueId: string;
  otherVenueId: string;
  systemAdmin: SeededUser;
  admin: SeededUser;
  planner: SeededUser;
  otherPlanner: SeededUser;
  otherVenueAdmin: SeededUser;
  couple: SeededUser;
  partner: SeededUser;
  suspendedPlanner: SeededUser;
  caseId: string;
  archivedCaseId: string;
  otherCaseId: string;
  taskId: string;
  invitationId: string;
}

async function createUser(
  db: TestDb,
  role: Role,
  venueId: string | null,
  email: string,
  status: 'active' | 'suspended' = 'active',
): Promise<SeededUser> {
  const authRes = await db.query<{ id: string }>(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  const authUserId = authRes.rows[0].id;
  const profileRes = await db.query<{ id: string }>(
    `insert into user_profiles (auth_user_id, venue_id, role, display_name, email, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [authUserId, venueId, role, email.split('@')[0], email, status],
  );
  return { authUserId, profileId: profileRes.rows[0].id, role, venueId };
}

export async function seedFixture(db: TestDb): Promise<Fixture> {
  return db.asOwner(async () => {
    const venue = await db.query<{ id: string }>(
      `select id from venues where code = 'BRIDAL01'`,
    );
    const venueId = venue.rows[0].id;

    const otherVenue = await db.query<{ id: string }>(
      `insert into venues (name, code) values ('別式場', 'BRIDAL02') returning id`,
    );
    const otherVenueId = otherVenue.rows[0].id;

    const systemAdmin = await createUser(db, 'system_admin', null, 'sysadmin@example.test');
    const admin = await createUser(db, 'admin', venueId, 'admin@example.test');
    const planner = await createUser(db, 'planner', venueId, 'planner@example.test');
    const otherPlanner = await createUser(db, 'planner', venueId, 'planner2@example.test');
    const otherVenueAdmin = await createUser(db, 'admin', otherVenueId, 'admin2@example.test');
    const suspendedPlanner = await createUser(
      db, 'planner', venueId, 'suspended@example.test', 'suspended',
    );
    const couple = await createUser(db, 'couple', venueId, 'groom@example.test');
    const partner = await createUser(db, 'couple', venueId, 'bride@example.test');

    const planType = await db.query<{ id: string }>(
      `select id from plan_types where venue_id = $1 order by display_order limit 1`,
      [venueId],
    );

    const mkCase = async (code: string, plannerId: string, archived = false, vid = venueId) => {
      const res = await db.query<{ id: string }>(
        `insert into wedding_cases
           (venue_id, plan_type_id, primary_planner_id, case_code, wedding_date, status, archived_at)
         values ($1, $2, $3, $4, current_date + 120, $5, $6) returning id`,
        [vid, vid === venueId ? planType.rows[0].id : null, plannerId, code,
         archived ? 'archived' : 'active', archived ? new Date().toISOString() : null],
      );
      return res.rows[0].id;
    };

    const caseId = await mkCase('BRIDAL01-2026-0001', planner.profileId);
    const archivedCaseId = await mkCase('BRIDAL01-2026-0002', planner.profileId, true);
    const otherCaseId = await mkCase('BRIDAL02-2026-0001', otherVenueAdmin.profileId, false, otherVenueId);

    await db.query(
      `insert into couple_profiles
         (case_id, user_profile_id, partner_role, full_name, is_primary_contact, memo)
       values ($1, $2, 'groom', '山田 太郎', true, 'この列は couple から読めてはいけない')`,
      [caseId, couple.profileId],
    );
    // 未招待の相手側（user_profile_id が NULL でも K01／K02 が0行にならないこと）
    await db.query(
      `insert into couple_profiles (case_id, partner_role, full_name)
       values ($1, 'bride', '山田 花子')`,
      [caseId],
    );

    const task = await db.query<{ id: string }>(
      `insert into case_tasks (case_id, title, submission_format, due_date, importance)
       values ($1, 'ゲストリスト提出', 'file', current_date + 60, 'critical') returning id`,
      [caseId],
    );

    const invitation = await db.query<{ id: string }>(
      `insert into case_invitations
         (case_id, invited_by, target_partner_role, token_hash, purpose, expires_at)
       values ($1, $2, 'bride', 'hash-bride-1', 'initial_registration', now() + interval '14 days')
       returning id`,
      [caseId, planner.profileId],
    );

    return {
      venueId, otherVenueId, systemAdmin, admin, planner, otherPlanner, otherVenueAdmin,
      couple, partner, suspendedPlanner,
      caseId, archivedCaseId, otherCaseId,
      taskId: task.rows[0].id,
      invitationId: invitation.rows[0].id,
    };
  });
}
