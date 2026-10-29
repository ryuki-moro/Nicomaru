import { execFileSync, spawn } from 'node:child_process';
import { encryptPii } from '../src/lib/crypto.ts';
import { randomBytes, hkdfSync } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures } from './d1-fixtures.mjs';

process.env.WRANGLER_SEND_METRICS = 'false';
await mkdir('.wrangler/app-local', { recursive: true });
const secretFile = '.wrangler/app-local/auth-secret';
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
    '.wrangler/app-local',
  ],
  { stdio: 'inherit', env: { ...process.env, CI: 'true' } },
);
const platform = await getPlatformProxy({
  configPath: 'cloudflare/wrangler.jsonc',
  persist: { path: '.wrangler/app-local/v3' },
});
try {
  const existing = await platform.env.DB.prepare('SELECT count(*) AS n FROM venues').first();
  if (!existing.n) {
    const fixture = await seedAppFixtures(platform.env.DB, encryptPii);
    await writeFile('.wrangler/app-local/credentials.json', JSON.stringify(fixture, null, 2), {
      flag: 'wx',
    });
  }
} finally {
  await platform.dispose();
}
console.log('D1ローカル準備完了。検証アカウント: .wrangler/app-local/credentials.json');
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
      BETTER_AUTH_SECRET: secret,
      DEV_ADMIN_LOGIN_ENABLED: 'false',
    },
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
