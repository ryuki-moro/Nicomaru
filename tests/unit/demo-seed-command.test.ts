import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  createClient: vi.fn(),
  pgConstructor: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  listUsers: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  seedDemo: vi.fn(),
  resetDemo: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: vi.fn(() => {
    throw new Error('テストは実際の.env.localを読み込まない');
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: fixture.createClient }));
vi.mock('pg', () => ({ Client: fixture.pgConstructor }));
vi.mock('../../scripts/demo/seed', () => ({
  seedDemo: fixture.seedDemo,
  resetDemo: fixture.resetDemo,
}));

const REF = 'abcdefghijklmnopqrst';
const PLANNER_EMAIL = 'planner@nicomaru.test';
const PLANNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const commandPath = '../../scripts/seed-demo.mts';
const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', `https://${REF}.supabase.co`);
  vi.stubEnv(
    'DEMO_DATABASE_URL',
    `postgres://postgres:fixture@db.${REF}.supabase.co:5432/postgres`,
  );
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only-fixture');
  vi.stubEnv('PII_ENCRYPTION_KEY', Buffer.alloc(32).toString('base64'));
  vi.stubEnv('PII_HMAC_KEY', Buffer.alloc(32).toString('base64'));
  vi.stubEnv('DEMO_PLANNER_PASSWORD', 'Fixture-only-Passw0rd!');
  vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:3000');
  vi.stubEnv('INTERNAL_CRON_SECRET', '');
  process.argv = ['node', 'seed-demo.mts', '--remote'];
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit blocked by test');
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fixture.createClient.mockReturnValue({
    auth: {
      admin: {
        listUsers: fixture.listUsers,
        createUser: fixture.createUser,
        updateUserById: fixture.updateUser,
      },
    },
  });
  fixture.pgConstructor.mockImplementation(function () {
    return { connect: fixture.connect, query: fixture.query, end: fixture.end };
  });
  fixture.connect.mockResolvedValue(undefined);
  fixture.end.mockResolvedValue(undefined);
  fixture.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  fixture.listUsers.mockResolvedValue({
    data: { users: [{ id: PLANNER_ID, email: PLANNER_EMAIL }] },
    error: null,
  });
  fixture.updateUser.mockResolvedValue({ error: null });
  fixture.createUser.mockResolvedValue({ data: { user: { id: PLANNER_ID } }, error: null });
  fixture.seedDemo.mockImplementation(async (_db, auth, options) => {
    await auth.ensureUser(PLANNER_EMAIL, {
      displayName: '模擬担当',
      password: options.plannerPassword,
    });
    return { plannerEmail: PLANNER_EMAIL, created: [], skipped: [] };
  });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('デモCLIは同一環境を確認してからAuthを変更する', () => {
  it('ローカルAuth/DBでもAPP_BASE_URLが外部なら接続・Auth変更・POST前に停止する', async () => {
    process.argv = ['node', 'seed-demo.mts'];
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('DEMO_DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
    vi.stubEnv('APP_BASE_URL', 'https://other-environment.example.test');
    vi.stubEnv('INTERNAL_CRON_SECRET', 'fixture-must-not-send');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network blocked by test'));
    await expect(import(commandPath)).rejects.toThrow('exit blocked by test');
    expect(fixture.createClient).not.toHaveBeenCalled();
    expect(fixture.pgConstructor).not.toHaveBeenCalled();
    expect(fixture.createUser).not.toHaveBeenCalled();
    expect(fixture.updateUser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('project-ref不一致ならAPI/DBクライアント作成前に停止する', async () => {
    vi.stubEnv(
      'DEMO_DATABASE_URL',
      'postgres://postgres:fixture@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres',
    );
    await expect(import(commandPath)).rejects.toThrow('exit blocked by test');
    expect(fixture.createClient).not.toHaveBeenCalled();
    expect(fixture.pgConstructor).not.toHaveBeenCalled();
    expect(fixture.createUser).not.toHaveBeenCalled();
    expect(fixture.updateUser).not.toHaveBeenCalled();
  });
  it('既存AuthのUUIDがDBに無い場合もAuth変更は0回', async () => {
    fixture.query.mockResolvedValue({ rows: [] });
    await expect(import(commandPath)).rejects.toThrow('exit blocked by test');
    expect(fixture.query).toHaveBeenCalledExactlyOnceWith(
      'select 1 from auth.users where id = $1',
      [PLANNER_ID],
    );
    expect(fixture.createUser).not.toHaveBeenCalled();
    expect(fixture.updateUser).not.toHaveBeenCalled();
    expect(fixture.seedDemo).not.toHaveBeenCalled();
    expect(fixture.end).toHaveBeenCalledOnce();
  });
  it('同じ既存UUIDの読取照合をパスワード変更より先に行う', async () => {
    await import(commandPath);
    expect(fixture.query).toHaveBeenNthCalledWith(1, 'select 1 from auth.users where id = $1', [
      PLANNER_ID,
    ]);
    expect(fixture.query.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.updateUser.mock.invocationCallOrder[0],
    );
    expect(fixture.updateUser).toHaveBeenCalledOnce();
    expect(fixture.query).toHaveBeenLastCalledWith('commit');
  });
  it('初回の空Authでも標準ローカルの組なら作成できる', async () => {
    process.argv = ['node', 'seed-demo.mts'];
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('DEMO_DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
    fixture.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    await import(commandPath);
    expect(fixture.createUser).toHaveBeenCalledOnce();
    expect(fixture.updateUser).not.toHaveBeenCalled();
    expect(fixture.query).toHaveBeenNthCalledWith(1, 'begin');
    expect(fixture.query.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.createUser.mock.invocationCallOrder[0],
    );
  });
  it('読取検証のAPI障害時もAuth変更0回で接続を閉じる', async () => {
    fixture.listUsers.mockResolvedValue({ data: null, error: new Error('fixture read failure') });
    await expect(import(commandPath)).rejects.toThrow('exit blocked by test');
    expect(fixture.createUser).not.toHaveBeenCalled();
    expect(fixture.updateUser).not.toHaveBeenCalled();
    expect(fixture.end).toHaveBeenCalledOnce();
  });
  it('後続失敗時はDB rollbackと残り得るAuth変更を区別して案内する', async () => {
    fixture.seedDemo.mockImplementation(async (_db, auth, options) => {
      await auth.ensureUser(PLANNER_EMAIL, {
        displayName: '模擬担当',
        password: options.plannerPassword,
      });
      throw new Error('fixture seed failure');
    });
    await expect(import(commandPath)).rejects.toThrow('exit blocked by test');
    expect(fixture.updateUser).toHaveBeenCalledOnce();
    expect(fixture.query).toHaveBeenLastCalledWith('rollback');
    const output = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(output).toContain('DB変更はロールバックしました');
    expect(output).toContain('Auth のユーザー作成・パスワード変更は残る場合があります');
    expect(output).not.toContain('何も変更していません');
  });
});
