/**
 * 実 PostgreSQL サーバー上に本番と同じマイグレーションを流す土台。
 *
 * `tests/db/harness.ts`（PGlite）との違いは **同時接続を張れること** の1点に尽きる。
 * PGlite は単一接続のWASMなので、設計が明示している次の性質を検証できない。
 *
 *   - 6-6-1「同一URLの同時2リクエストでも1つしか通らない」（招待トークンの原子的消費）
 *   - 5-7「UNIQUE 違反時は採番をやり直して再試行」（case_code の採番競合）
 *   - 5-3「insert ... on conflict do update returning による原子的インクリメント」（レート制限）
 *   - 6-9「同時リクエストによる上限超過の競合を防ぐ」
 *
 * 接続情報が無い環境では呼び出し側が describe.skipIf で丸ごと飛ばす。
 * CI と通常の開発は PGlite 側だけで完結し、こちらは任意の追加検証という位置づけ。
 *
 * 起動例（管理者権限不要・サービス登録なし）:
 *   C:\tools\pgsql\bin\pg_ctl -D C:\tools\pgdata-nicomaru ^
 *     -o "-p 5433 -c listen_addresses=127.0.0.1" -l server.log start
 *   set TEST_PG_URL=postgres://postgres:nicomaru_local@127.0.0.1:5433/postgres
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Client, Pool } from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');
const SEED_PATH = join(process.cwd(), 'supabase', 'seed.sql');

/** 接続文字列。未設定なら実PGテストは skip する。 */
export const PG_URL = process.env.TEST_PG_URL ?? '';
export const hasRealPg = PG_URL !== '';

/**
 * Supabase 側が提供する前提のオブジェクト。
 * harness.ts と同一にしておく（片方だけ変わると検証結果がずれる）。
 */
const SUPABASE_STUB = `
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

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

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** テスト用データベースを作り直し、マイグレーションと seed を適用する。 */
export async function createTestDatabase(dbName: string): Promise<string> {
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  try {
    // 前回の残骸を落とす。接続が残っていると drop できないので強制切断する。
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
    await admin.query(`drop database if exists ${dbName}`);
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }

  const url = PG_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(SUPABASE_STUB);
    for (const file of migrationFiles()) {
      try {
        await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      } catch (error) {
        throw new Error(`migration failed: ${file}\n${(error as Error).message}`);
      }
    }
    await db.query(readFileSync(SEED_PATH, 'utf8'));
  } finally {
    await db.end();
  }
  return url;
}

/**
 * 同時実行を張るためのプール。
 * `asUser` は接続を1本占有し、その接続上で JWT クレームとロールを設定する
 * （GUC と SET ROLE は接続単位なので、プールから借りた1本に閉じ込める必要がある）。
 */
export class PgTestDb {
  private constructor(readonly pool: Pool, readonly url: string) {}

  static async create(dbName = 'nicomaru_concurrency_test'): Promise<PgTestDb> {
    const url = await createTestDatabase(dbName);
    return new PgTestDb(new Pool({ connectionString: url, max: 16 }), url);
  }

  /** 所有者（RLS をバイパスする）で実行する。 */
  async asOwner<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`reset role; select set_config('request.jwt.claim.sub', '', false)`);
      return await fn((sql, params) => client.query(sql, params));
    } finally {
      client.release();
    }
  }

  /** authenticated ロール＋指定ユーザーの JWT で実行する。接続を1本占有する。 */
  async asUser<T>(authUserId: string | null, fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [authUserId ?? '']);
      await client.query('set role authenticated');
      return await fn((sql, params) => client.query(sql, params));
    } finally {
      await client.query('reset role').catch(() => undefined);
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export type Querier = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
