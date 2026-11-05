import { execFileSync, spawn } from 'node:child_process';
import { encryptPii } from '../src/lib/crypto.ts';
import { randomBytes, hkdfSync } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures } from './d1-fixtures.mjs';
import { seedDemoFixtures } from './d1-demo-fixtures.mjs';

// --demo: ログイン不要デモ（架空の5案件・ログイン素通り）。--reset でデモのデータを作り直す。
const demo = process.argv.includes('--demo');
const dir = demo ? '.wrangler/demo' : '.wrangler/app-local';
process.env.WRANGLER_SEND_METRICS = 'false';
if (demo && process.argv.includes('--reset')) await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const secretFile = `${dir}/auth-secret`;
let secret;
try {
  secret = await readFile(secretFile, 'utf8');
} catch {
  secret = randomBytes(32).toString('hex');
  await writeFile(secretFile, secret, { flag: 'wx' });
}
process.env.PII_ENCRYPTION_KEY = Buffer.from(
  hkdfSync('sha256', Buffer.from(secret, 'hex'), '', 'nicomaru-local-pii', 32),
).toString('base64');
const demoPassword = Buffer.from(
  hkdfSync('sha256', Buffer.from(secret, 'hex'), '', 'nicomaru-demo-login', 24),
).toString('base64url');
process.env.PII_HMAC_KEY = Buffer.from(
  hkdfSync('sha256', Buffer.from(secret, 'hex'), '', 'nicomaru-local-hmac', 32),
).toString('base64');
execFileSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--config',
    'cloudflare/wrangler.jsonc',
    '--persist-to',
    dir,
  ],
  { stdio: 'inherit', env: { ...process.env, CI: 'true' } },
);
const platform = await getPlatformProxy({
  configPath: 'cloudflare/wrangler.jsonc',
  persist: { path: `${dir}/v3` },
});
try {
  const existing = await platform.env.DB.prepare('SELECT count(*) AS n FROM venues').first();
  if (!existing.n) {
    const fixture = demo
      ? await seedDemoFixtures(platform.env.DB, encryptPii, demoPassword)
      : await seedAppFixtures(platform.env.DB, encryptPii);
    await writeFile(`${dir}/credentials.json`, JSON.stringify(fixture, null, 2), { flag: 'wx' });
  }
} finally {
  await platform.dispose();
}
const demoLogin = demo ? JSON.parse(await readFile(`${dir}/credentials.json`, 'utf8')) : null;
console.log(
  demo
    ? 'デモの準備完了。http://127.0.0.1:3104/login を開き、そのままログインしてください。'
    : 'D1ローカル準備完了。検証アカウント: .wrangler/app-local/credentials.json',
);
if (process.argv.includes('--setup-only')) process.exit(0);
const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3104'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NICOMARU_DB: 'd1-local',
      NEXT_PUBLIC_NICOMARU_DB: 'd1-local',
      APP_BASE_URL: 'http://127.0.0.1:3104',
      NICOMARU_D1_DIR: dir,
      BETTER_AUTH_SECRET: secret,
      DEV_ADMIN_LOGIN_ENABLED: 'false',
      ...(demoLogin && {
        NICOMARU_DEMO_LOGIN: 'true',
        NEXT_PUBLIC_NICOMARU_DEMO_LOGIN: 'true',
        DEMO_PLANNER_EMAIL: demoLogin.planner,
        DEMO_COUPLE_EMAIL: demoLogin.couple,
        DEMO_LOGIN_PASSWORD: demoPassword,
      }),
    },
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
