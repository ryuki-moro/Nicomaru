/**
 * Issue #19: 通常成功 → 過去の409をブラウザ内で注入して失敗 → 注入なしで再成功。
 * リポジトリのルートから node tests/e2e/check-regression.mjs で実行する。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const env = { ...process.env };
if (!env.CI && existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] ??= match[2].replace(/^"(.*)"$/, '$1');
  }
}
delete env.E2E_INJECT_SHARED_SUBMIT_CONFLICT;
delete env.PLAYWRIGHT_JSON_OUTPUT_FILE;
delete env.PLAYWRIGHT_JSON_OUTPUT_NAME;
delete env.PLAYWRIGHT_JSON_OUTPUT_DIR;

for (const key of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'E2E_SUPABASE_SERVICE_ROLE_KEY',
]) {
  if (!env[key]) throw new Error(key + ' が未設定です。skipを成功として記録しません。');
}
for (const value of [env.APP_BASE_URL ?? 'http://localhost:3000', env.NEXT_PUBLIC_SUPABASE_URL]) {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('負例確認はローカルの使い捨てアプリ・Supabaseだけで実行してください。');
  }
}

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const output = resolve(
  'test-results/issue-19-regression',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
mkdirSync(output, { recursive: true });
const phases = [];
const title = '片方が一時保存しても、もう片方が同じ宿題を提出できる';

function collectTests(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) =>
      (spec.tests ?? []).map((test) => ({ ...test, title: spec.title })),
    ),
    ...collectTests(suite.suites ?? []),
  ]);
}

function run(phase, inject) {
  const dir = resolve(output, phase);
  mkdirSync(dir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'test',
      'tests/e2e/core-flow.spec.ts',
      '--project=chromium',
      '--grep=' + title,
      '--retries=0',
      '--reporter=json',
      '--output=' + resolve(dir, 'artifacts'),
    ],
    {
      env: { ...env, E2E_INJECT_SHARED_SUBMIT_CONFLICT: inject ? '1' : '0' },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(resolve(dir, 'report.json'), result.stdout ?? '');
  writeFileSync(resolve(dir, 'stderr.log'), result.stderr ?? '');
  let valid = false;
  try {
    const report = JSON.parse(result.stdout);
    const tests = collectTests(report.suites ?? []);
    const target = tests[0];
    const results = target?.results ?? [];
    const errorText = results
      .flatMap((item) => [item.error, ...(item.errors ?? [])])
      .map((error) => error?.message ?? '')
      .join('\n');
    valid =
      !result.error &&
      !result.signal &&
      tests.length === 1 &&
      target.title === title &&
      results.length === 1 &&
      (report.errors ?? []).length === 0 &&
      (inject
        ? result.status === 1 &&
          target.status === 'unexpected' &&
          results[0].status === 'failed' &&
          errorText.includes('E2E_SUBMIT_ACCEPTED: HTTP 409')
        : result.status === 0 && target.status === 'expected' && results[0].status === 'passed');
  } catch {
    // セットアップ失敗・JSONなし・skip・別原因の失敗を負例の成功へ読み替えない。
  }
  phases.push({ phase, valid, exitCode: result.status });
  console.log(phase + ': ' + (valid ? '確認できました' : '未確認/想定外の結果'));
  return valid;
}

let complete = false;
try {
  if (run('baseline', false)) {
    const detected = run('injected-409', true);
    const restored = run('restored', false);
    complete = detected && restored;
  }
} finally {
  writeFileSync(
    resolve(output, 'summary.json'),
    JSON.stringify({ complete, phases }, null, 2) + '\n',
  );
  console.log('検証記録: ' + output);
}
if (!complete) process.exitCode = 1;
