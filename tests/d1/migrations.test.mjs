import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';

const dir = 'cloudflare/migrations';
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
const read = (f) => readFile(`${dir}/${f}`, 'utf8');
const statements = (sql) =>
  sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

// 空のテーブルでは通り、行のある本番だけで失敗するため、ローカル適用では気づけない（SQLite の制約）
test('ADD COLUMN に CURRENT_TIMESTAMP などの非定数の既定値を使わない', async () => {
  const bad = [];
  for (const f of files)
    for (const s of statements(await read(f)))
      if (/ADD\s+COLUMN[^]*DEFAULT\s*(CURRENT_|\()/i.test(s))
        bad.push(`${f}: ${s.split('\n').pop()}`);
  assert.deepEqual(bad, []);
});

test('本番と同じく 0007 まで適用済みで行のある DB へ、残りの migration を順に適用できる', async () => {
  const platform = await getPlatformProxy({
    configPath: 'cloudflare/wrangler.jsonc',
    persist: false,
  });
  const db = platform.env.DB;
  const apply = async (f) => db.batch(statements(await read(f)).map((s) => db.prepare(s)));
  try {
    for (const f of files.filter((f) => f < '0008')) await apply(f);
    await db.batch([
      db.prepare("INSERT INTO venues(id,name,code) VALUES ('v1','式場','V1')"),
      db.prepare("INSERT INTO plan_types(id,venue_id,name) VALUES ('p1','v1','一般')"),
    ]);
    for (const f of files.filter((f) => f >= '0008'))
      await assert.doesNotReject(apply(f), `${f} の適用に失敗`);
    const venue = await db
      .prepare("SELECT created_at,updated_at FROM venues WHERE id='v1'")
      .first();
    assert.notEqual(venue.created_at, '1970-01-01 00:00:00', '既存行は現在時刻で埋める');
  } finally {
    await platform.dispose();
  }
});
