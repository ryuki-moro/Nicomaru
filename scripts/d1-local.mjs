import { execFileSync, spawn } from 'node:child_process';
import { encryptPii } from '../src/lib/crypto.ts';
import { randomBytes, hkdfSync } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { seedAppFixtures } from './d1-fixtures.mjs';
import { seedDemoFixtures } from './d1-demo-fixtures.mjs';
import { renameAppliedMigrations } from './d1-renamed-migrations.mjs';

// --demo: ログイン不要デモ（架空の5案件・ログイン素通り）。--reset でデモのデータを作り直す。
const demo = process.argv.includes('--demo');
const dir = demo ? '.wrangler/demo' : '.wrangler/app-local';
// dev:d1 と同時に起動できるよう、デモは別のポートで待ち受ける（src/lib/d1/mode.ts の isLocalD1Origin）。
const port = demo ? '3105' : '3104';
const origin = `http://127.0.0.1:${port}`;
process.env.WRANGLER_SEND_METRICS = 'false';
const secretFile = `${dir}/auth-secret`;
if (demo && process.argv.includes('--reset')) {
  // 秘密値は残す。AIワーカーのトークンが変わらず、やり直してもワーカーを起動し直さずに済む
  const kept = await readFile(secretFile, 'utf8').catch(() => null);
  await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  await mkdir(dir, { recursive: true });
  if (kept) await writeFile(secretFile, kept);
}
await mkdir(dir, { recursive: true });
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
// AIワーカー（npm run demo:ai）と同じ値を秘密値から導く。外部へは出ない
process.env.AI_WORKER_TOKEN = Buffer.from(
  hkdfSync('sha256', Buffer.from(secret, 'hex'), '', 'nicomaru-local-ai-worker', 32),
).toString('base64url');
// チャットWorker(別プロセス)と本体で共有するチケット署名の秘密値
const chatSecret = Buffer.from(
  hkdfSync('sha256', Buffer.from(secret, 'hex'), '', 'nicomaru-local-chat-ticket', 32),
).toString('base64url');
const chatPort = demo ? '8795' : '8794';
const setupOnly = process.argv.includes('--setup-only');
// Windows では child.kill() が孫プロセス(workerd)を残すため、プロセスツリーごと止める
const killTree = (c) => {
  if (!c || c.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  } else c.kill('SIGTERM');
};
// 本体の service binding(CHAT)が解決できるよう、getPlatformProxy より先に起動する
const chat = setupOnly
  ? null
  : spawn(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '-c',
        'cloudflare/chat/wrangler.jsonc',
        '--port',
        chatPort,
        '--ip',
        '127.0.0.1',
        '--inspector-port',
        demo ? '9395' : '9394',
        '--persist-to',
        `${dir}/chat`,
        '--var',
        `APP_BASE_URL:${origin}`,
        '--var',
        `CHAT_TICKET_SECRET:${chatSecret}`,
        '--show-interactive-dev-session=false',
      ],
      { stdio: 'inherit', env: { ...process.env, CI: 'true' } },
    );
process.on('exit', () => killTree(chat));
// 番号を付け替える前の名前で適用済みの手元DBを、今の名前に揃えてから流す（Issue #266）
{
  const before = await getPlatformProxy({
    configPath: 'cloudflare/wrangler.jsonc',
    persist: { path: `${dir}/v3` },
  });
  try {
    for (const { from, to } of await renameAppliedMigrations(before.env.DB)) {
      console.log(`適用済みのマイグレーション名を付け替えました: ${from} → ${to}`);
    }
  } finally {
    await before.dispose();
  }
}
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
      ? await seedDemoFixtures(platform.env.DB, encryptPii, demoPassword, platform.env.FILES)
      : await seedAppFixtures(platform.env.DB, encryptPii);
    await writeFile(`${dir}/credentials.json`, JSON.stringify(fixture, null, 2), { flag: 'wx' });
  }
} finally {
  await platform.dispose();
}
const demoLogin = demo ? JSON.parse(await readFile(`${dir}/credentials.json`, 'utf8')) : null;
if (!demo) console.log('D1ローカル準備完了。検証アカウント: .wrangler/app-local/credentials.json');
if (setupOnly) process.exit(0);
const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', port],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NICOMARU_DB: 'd1-local',
      NEXT_PUBLIC_NICOMARU_DB: 'd1-local',
      APP_BASE_URL: origin,
      CHAT_WS_URL: `ws://127.0.0.1:${chatPort}/ws`,
      CHAT_TICKET_SECRET: chatSecret,
      NICOMARU_D1_DIR: dir,
      BETTER_AUTH_SECRET: secret,
      ...(demoLogin && {
        NICOMARU_DEMO_LOGIN: 'true',
        NEXT_PUBLIC_NICOMARU_DEMO_LOGIN: 'true',
        DEMO_PLANNER_EMAIL: demoLogin.planner,
        DEMO_COUPLE_EMAIL: demoLogin.couple,
        DEMO_LOGIN_PASSWORD: demoPassword,
        // 打ち合わせ記録を ?memo=demo で開くと、メモ欄にこの文面が入った状態になる
        DEMO_MEETING_MEMO: await readFile('docs/発表/AIデモ/打ち合わせメモ.txt', 'utf8').catch(
          () => '',
        ),
      }),
    },
  },
);
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
if (demo) await warmDemo();

// next dev は画面を初めて開いたときにコンパイルする（1画面20秒前後）。
// 発表中に待たないよう、ログインと主な画面を先に一度開いておく。
async function warmDemo() {
  const get = (path, cookie) =>
    fetch(origin + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' }).then((r) =>
      r.text(),
    );
  for (;;) {
    try {
      await get('/login');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const pages = {
    couple: [
      '/mypage',
      '/mypage/tasks',
      '/mypage/guests',
      '/mypage/seating',
      '/mypage/timeline',
      '/mypage/case',
      '/mypage/notifications',
    ],
    planner: [
      '/cases',
      '/dashboard',
      '/notifications',
      '/submissions',
      '/templates',
      '/plan-types',
    ],
  };
  for (const [role, paths] of Object.entries(pages)) {
    try {
      const response = await fetch(`${origin}/api/auth/demo-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ role }),
      });
      const cookie = response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      for (const path of paths) {
        const html = await get(path, cookie);
        const caseId = path === '/cases' && html.match(/\/cases\/([\w-]{8,})/)?.[1];
        if (caseId)
          for (const sub of ['', '/sheet', '/follow', '/meeting-notes'])
            await get(`/cases/${caseId}${sub}`, cookie);
      }
    } catch (cause) {
      console.warn(`画面の事前準備に失敗しました（${role}）: ${cause}`);
    }
  }
  console.log(`デモの準備完了。${origin}/login を開き、そのままログインしてください。`);
}
