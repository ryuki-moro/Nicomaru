import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import {
  RENAMED_MIGRATIONS,
  renameAppliedMigrations,
} from '../../scripts/d1-renamed-migrations.mjs';

// Issue #266: 付け替える前の名前で適用済みの手元DBを、今の名前に揃えてから流す
let platform, db;
const names = async () =>
  (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((r) => r.name);
const record = (...list) =>
  db.batch(
    list.map((name) => db.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(name)),
  );

before(async () => {
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
});
after(() => platform?.dispose());
beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS d1_migrations');
});

const createTable = () =>
  db.exec(
    'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );

test('適用記録の表がない新しいDBには何もしない', async () => {
  assert.deepEqual(await renameAppliedMigrations(db), []);
});

test('旧名だけが記録されていれば新名に書き換える', async () => {
  await createTable();
  await record('0023_ai_ext.sql', '0024_seating_table_scale.sql', '0024_ai_prompts_v2.sql');
  assert.deepEqual(await renameAppliedMigrations(db), [
    { from: '0024_seating_table_scale.sql', to: '0026_seating_table_scale.sql' },
  ]);
  assert.deepEqual(await names(), [
    '0023_ai_ext.sql',
    '0026_seating_table_scale.sql',
    '0024_ai_prompts_v2.sql',
  ]);
  // 2回目は書き換えるものがない
  assert.deepEqual(await renameAppliedMigrations(db), []);
});

test('新名がすでに記録されていれば旧名に触れない', async () => {
  await createTable();
  await record('0024_seating_table_scale.sql', '0026_seating_table_scale.sql');
  assert.deepEqual(await renameAppliedMigrations(db), []);
  assert.deepEqual(await names(), ['0024_seating_table_scale.sql', '0026_seating_table_scale.sql']);
});

test('対応表の新名は実在し、旧名はもう残っていない', async () => {
  const files = new Set(await readdir('cloudflare/migrations'));
  for (const { from, to } of RENAMED_MIGRATIONS) {
    assert.ok(files.has(to), `${to} がない`);
    assert.ok(!files.has(from), `${from} が残っている`);
  }
});
