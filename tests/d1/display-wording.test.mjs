import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';

// Issue #264: 初期データ由来で画面に出る「宿題」を 0027 で「やること」に置き換える
const dir = 'cloudflare/migrations';
const target = '0027_display_wording.sql';
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
const statements = (sql) =>
  sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

let platform, db;
const apply = async (f) =>
  db.batch(statements(await readFile(`${dir}/${f}`, 'utf8')).map((s) => db.prepare(s)));

before(async () => {
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const f of files.filter((f) => f < target)) await apply(f);
  // 0027 より前に算出済みの理由（旧い文言の写し）を1件置いておく
  await db.batch([
    db.prepare("INSERT INTO venues(id,name,code) VALUES ('v1','式場','V1')"),
    db.prepare(
      "INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES ('u1','担当','planner@example.test',1,0,0)",
    ),
    db.prepare(
      "INSERT INTO user_profiles(id,venue_id,role,status) VALUES ('u1','v1','planner','active')",
    ),
    db.prepare(
      "INSERT INTO wedding_cases(id,venue_id,primary_planner_id,case_code,wedding_date) VALUES ('case-x','v1','u1','X-001','2027-01-01')",
    ),
  ]);
  await db
    .prepare(
      "INSERT INTO risk_score_snapshots(id,case_id,score_value,score_level,reasons,is_current,calculated_at) VALUES ('snap-1','case-x',40,'high',?,1,'2026-11-01T00:00:00Z')",
    )
    .bind(
      JSON.stringify([
        {
          conditionKey: 'task_overdue',
          name: '期限超過の未提出宿題がある',
          description: '提出期限を過ぎた宿題があります',
        },
      ]),
    )
    .run();
  await apply(target);
});
after(() => platform?.dispose());

const leftovers = async () => {
  const rules = await db
    .prepare(
      "SELECT condition_key FROM risk_rules WHERE venue_id IS NULL AND (name LIKE '%宿題%' OR description LIKE '%宿題%')",
    )
    .all();
  const prompts = await db
    .prepare(
      "SELECT id FROM ai_prompt_templates WHERE venue_id IS NULL AND (name LIKE '%宿題%' OR prompt_text LIKE '%宿題%')",
    )
    .all();
  const snaps = await db
    .prepare("SELECT id FROM risk_score_snapshots WHERE reasons LIKE '%宿題%'")
    .all();
  return [...rules.results, ...prompts.results, ...snaps.results];
};

test('遅れの理由・AIの指示文・算出済みの理由に「宿題」が残らない', async () => {
  assert.deepEqual(await leftovers(), []);
  const rule = await db
    .prepare("SELECT name,description FROM risk_rules WHERE condition_key='task_overdue'")
    .first();
  assert.deepEqual(rule, {
    name: '期限を過ぎた未提出のやることがある',
    description: '提出期限を過ぎたやることがあります',
  });
  const snap = await db
    .prepare("SELECT reasons FROM risk_score_snapshots WHERE id='snap-1'")
    .first();
  assert.deepEqual(JSON.parse(snap.reasons), [
    {
      conditionKey: 'task_overdue',
      name: '期限を過ぎた未提出のやることがある',
      description: '提出期限を過ぎたやることがあります',
    },
  ]);
});

test('識別子とコード値は変えない', async () => {
  const keys = await db
    .prepare('SELECT condition_key FROM risk_rules WHERE venue_id IS NULL ORDER BY condition_key')
    .all();
  assert.deepEqual(
    keys.results.map((r) => r.condition_key),
    ['important_task_overdue', 'needs_fix_exists', 'no_activity_days', 'task_overdue'],
  );
  const prompt = await db
    .prepare(
      "SELECT job_type,version,prompt_text FROM ai_prompt_templates WHERE id='00000000-0000-4000-a000-000000000011'",
    )
    .first();
  assert.equal(prompt.job_type, 'task_extraction');
  assert.equal(prompt.version, 2);
  assert.match(prompt.prompt_text, /"title": "やることの名前"/);
});

test('手元DBにもう一度流しても結果が変わらない', async () => {
  const snapshot = async () =>
    JSON.stringify([
      (await db.prepare('SELECT * FROM risk_rules ORDER BY id').all()).results,
      (await db.prepare('SELECT id,name,prompt_text FROM ai_prompt_templates ORDER BY id').all())
        .results,
      (await db.prepare('SELECT id,reasons FROM risk_score_snapshots ORDER BY id').all()).results,
    ]);
  const first = await snapshot();
  await apply(target);
  assert.equal(await snapshot(), first);
});
