// npm run demo:all — AIデモの準備を1コマンドで終える（#238・#239）。
//   1. デモのデータを初期化してアプリを起動（npm run demo -- --reset と同じ）
//   2. AIワーカーを起動し、LLMとの疎通とモデルの読み込みまで済ませる（npm run demo:ai と同じ。引数はそのまま渡す）
//   3. プランナーと新郎新婦を左右に並べる画面を http://demo.localhost:3106/ で開けるようにする
// 左右で別々にログインできるよう、ホスト名を分けた中継（p.demo.localhost / c.demo.localhost）を挟む。
// Cookie はホスト名ごとに保持されるので、同じブラウザでも互いのログインを上書きしない。
// 中継はこのPCのループバックだけで待ち受け、アプリ側（本番の画面・API）には手を入れない。
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

import { parseScript } from './demo-script.mjs';

const APP = 'http://127.0.0.1:3105';
const APP_HOST = '127.0.0.1:3105';
const PORT = 3106;
const HOME = `demo.localhost:${PORT}`;
const ROLE_HOST = {
  [`p.demo.localhost:${PORT}`]: 'planner',
  [`c.demo.localhost:${PORT}`]: 'couple',
};

const DOCS = 'docs/発表/AIデモ';
const PID_FILE = '.wrangler/demo-all.pid';
const OPEN = process.argv.includes('--open');
const workerArgs = process.argv.slice(2).filter((arg) => arg !== '--open');
const state = {
  phase: 'starting',
  ai: 'starting',
  coupleUrl: '/mypage',
  scenes: null,
  // 予備・説明用の画像（画面/ の 01_… など）
  slides: (await readdir(`${DOCS}/画面`).catch(() => [])).filter((f) => f.endsWith('.png')),
};
let app;
let worker;

const log = (message) => console.log(`[demo:all] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pipeLines(stream, prefix, filter = () => true) {
  createInterface({ input: stream }).on('line', (line) => {
    if (filter(line)) console.log(`${prefix} ${line}`);
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // すでに終わっている
  }
}

function startApp() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/d1-local.mjs', '--demo', '--reset'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
  );
  // ワーカーの問い合わせ（0.3秒ごと）の記録で画面が流れないようにする
  const quiet = (line) => !line.includes('"route":"/api/internal/ai-worker"');
  pipeLines(child.stdout, '[アプリ]', quiet);
  pipeLines(child.stderr, '[アプリ]', quiet);
  return child;
}

async function waitReady(child) {
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw new Error('アプリの起動に失敗しました（上のログを確認）');
    const ok = await fetch(`${APP}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('アプリが5分たっても応答しません');
}

const cookieHeader = (setCookies) => setCookies.map((c) => c.split(';')[0]).join('; ');

/** デモのアカウントでログインし、Set-Cookie をそのまま返す（/api/auth/demo-login は npm run demo 専用） */
async function demoSignIn(role) {
  const response = await fetch(`${APP}/api/auth/demo-login`, {
    method: 'POST',
    headers: { origin: APP, 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) throw new Error(`デモのログインに失敗しました（${response.status}）`);
  return response.headers.getSetCookie();
}

/** 初回の表示で画面のコンパイル待ちが入らないよう、使う画面とAPIを先に一度開いておく */
async function warmUp() {
  const { scenes } = JSON.parse(await readFile('.wrangler/demo/credentials.json', 'utf8'));
  state.scenes = scenes;
  const submission = (path) => path.split('/').pop().split('?')[0];
  const caseId = scenes.meeting.split('/')[2];
  const visit = async (cookie, path) =>
    fetch(`${APP}${path}`, { headers: { cookie }, redirect: 'manual' }).catch(() => undefined);
  sessions.planner = await demoSignIn('planner');
  sessions.couple = await demoSignIn('couple');
  const planner = cookieHeader(sessions.planner);
  const couple = cookieHeader(sessions.couple);
  for (const path of [
    scenes.meeting,
    scenes.guests,
    scenes.bgm,
    '/cases',
    '/submissions',
    '/api/ai/status',
    '/api/ai/jobs',
    '/api/ai/jobs/00000000-0000-4000-8000-000000000000',
    `/api/submissions/${submission(scenes.guests)}/defect-check`,
    `/api/submissions/${submission(scenes.guests)}/review`,
    `/api/cases/${caseId}/tasks`,
  ])
    await visit(planner, path);
  for (const path of ['/mypage', '/mypage/tasks', '/mypage/guests']) await visit(couple, path);
}

async function bootApp() {
  state.phase = 'resetting';
  killTree(app);
  app = startApp();
  await waitReady(app);
  log('画面を準備しています…');
  await warmUp();
  state.coupleUrl = '/mypage';
  state.phase = 'ready';
}

function startWorker() {
  const child = spawn(process.execPath, ['scripts/demo-ai.mjs', ...workerArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  // やり直しでアプリが止まっている間の接続エラーは表示しない（ワーカーは自動でつなぎ直す）
  const quiet = (line) => !(state.phase === 'resetting' && line.includes('ループでエラー'));
  pipeLines(child.stdout, '[AI]', quiet);
  pipeLines(child.stderr, '[AI]', quiet);
  return new Promise((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.includes('起動しました')) resolve(true);
    });
    child.on('exit', () => {
      state.ai = 'stopped';
      resolve(false);
    });
    worker = child;
  });
}

// --- 中継（p./c. のホストをアプリへ渡す） ---

function forwardHeaders(req) {
  const self = `http://${req.headers.host}`;
  const headers = { ...req.headers, host: APP_HOST };
  // 自分のホストからの送信だけを、アプリのOriginとして渡す（それ以外はそのまま渡してアプリに拒否させる）
  if (headers.origin === self) headers.origin = APP;
  if (headers.referer?.startsWith(`${self}/`))
    headers.referer = APP + headers.referer.slice(self.length);
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-for'];
  return headers;
}

/**
 * 役割ごとに1つのログインを使い回す（ログインは1分10回までに制限されているため、開くたびにログインしない）。
 * やり直しではデータごと消えるので、warmUp で取り直す。
 */
const sessions = { planner: [], couple: [] };
const loginQueue = { planner: Promise.resolve(), couple: Promise.resolve() };

/** /__demo/login?next=/path — ログイン済みならそのまま、未ログインならデモのアカウントでログインして開く */
async function handleLogin(req, res, role, url) {
  const next = url.searchParams.get('next') ?? '/';
  // 同じホスト内のパスだけ（//host や /\host は別サイトへ飛ぶため拒否）
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return send(res, 400, 'next が不正です');
  const run = loginQueue[role].then(async () => {
    const valid = async (cookie) =>
      (
        await fetch(`${APP}${next}`, { headers: { cookie }, redirect: 'manual' }).catch(
          () => undefined,
        )
      )?.status === 200;
    let setCookies = [];
    if (!(await valid(req.headers.cookie ?? ''))) {
      if (!(await valid(cookieHeader(sessions[role])))) {
        sessions[role] = await demoSignIn(role);
        // ログインしても開けない画面で、/login との往復を繰り返さない
        if (!(await valid(cookieHeader(sessions[role]))))
          throw new Error(`この画面（${next}）はデモのアカウントで開けません`);
      }
      setCookies = sessions[role];
    }
    res.writeHead(302, { location: next, 'set-cookie': setCookies, 'cache-control': 'no-store' });
    res.end();
  });
  loginQueue[role] = run.catch(() => undefined);
  await run.catch((error) => send(res, 503, error.message));
}

function proxy(req, res, role) {
  // 新郎新婦側で今開いている画面を覚えておき、「更新」で同じ画面を開き直す
  if (role === 'couple' && req.method === 'GET' && !req.url.startsWith('/_next')) {
    const navigate = req.headers['sec-fetch-mode'] === 'navigate';
    const softNav = req.headers.rsc === '1' && !req.headers['next-router-prefetch'];
    if (navigate || softNav) {
      const target = new URL(req.url, APP);
      target.searchParams.delete('_rsc');
      if (!target.pathname.startsWith('/__demo') && !target.pathname.startsWith('/api'))
        state.coupleUrl = target.pathname + target.search;
    }
  }
  const upstream = httpRequest(
    `${APP}${req.url}`,
    { method: req.method, headers: forwardHeaders(req) },
    (response) => {
      const headers = { ...response.headers };
      // ログインが切れて /login へ戻された画面は、ログインし直して同じ画面を開く（セッションは1時間で切れる）
      if (
        req.method === 'GET' &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        headers.location &&
        new URL(headers.location, APP).pathname === '/login'
      ) {
        response.resume();
        res.writeHead(302, {
          location: `/__demo/login?next=${encodeURIComponent(req.url)}`,
          'cache-control': 'no-store',
        });
        return res.end();
      }
      if (headers.location?.startsWith(APP))
        headers.location = `http://${req.headers.host}${headers.location.slice(APP.length)}`;
      // 埋め込みは左右並べの画面からだけ許す（ほかのサイトに埋め込まれて操作させられないように）
      delete headers['x-frame-options'];
      headers['content-security-policy'] = [
        headers['content-security-policy'],
        `frame-ancestors http://${HOME}`,
      ]
        .filter(Boolean)
        .join('; ');
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
    },
  );
  upstream.on('error', () =>
    send(
      res,
      503,
      state.phase === 'resetting' ? 'やり直し中です。少し待ってください。' : 'アプリに届きません',
    ),
  );
  req.pipe(upstream);
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function handleHome(req, res, url) {
  const html = (file) =>
    readFile(file, 'utf8').then((body) => send(res, 200, body, 'text/html; charset=utf-8'));
  if (req.method === 'GET' && url.pathname === '/') return html('scripts/demo-presenter.html');
  if (req.method === 'GET' && url.pathname === '/audience')
    return html('scripts/demo-audience.html');
  if (req.method === 'GET' && url.pathname === '/__demo/script')
    return send(
      res,
      200,
      JSON.stringify(parseScript(await readFile(`${DOCS}/発表台本.md`, 'utf8'))),
      'application/json',
    );
  if (req.method === 'GET' && url.pathname.startsWith('/__demo/slide/')) {
    let name = '';
    try {
      name = decodeURIComponent(url.pathname.slice('/__demo/slide/'.length));
    } catch {}
    // 一覧にある名前だけ返す（パスをたどらせない）
    if (!state.slides.includes(name)) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return res.end(await readFile(`${DOCS}/画面/${name}`));
  }
  if (url.pathname === '/__demo/state' && req.method === 'GET')
    return send(res, 200, JSON.stringify(state), 'application/json');
  if (url.pathname === '/__demo/reset' && req.method === 'POST') {
    if (req.headers.origin !== `http://${HOME}`) return send(res, 403, 'forbidden');
    reset();
    return send(res, 202, '{}', 'application/json');
  }
  send(res, 404, 'not found');
}

const server = createServer((req, res) => {
  const host = req.headers.host ?? '';
  const url = new URL(req.url ?? '/', 'http://x');
  // 想定したホスト名以外は受けない（DNS rebinding 対策）
  if (host === HOME)
    return void handleHome(req, res, url).catch((error) => {
      console.error('[demo] 画面の処理に失敗:', error.message);
      if (!res.headersSent) send(res, 500, 'error');
      else res.end();
    });
  const role = ROLE_HOST[host];
  if (!role) return send(res, 404, 'not found');
  if (url.pathname === '/__demo/login') return void handleLogin(req, res, role, url);
  proxy(req, res, role);
});

// 開発サーバーの自動更新（WebSocket）も中継する
server.on('upgrade', (req, socket, head) => {
  if (!ROLE_HOST[req.headers.host ?? '']) return socket.destroy();
  const upstream = connect(3105, '127.0.0.1', () => {
    const lines = Object.entries(forwardHeaders(req)).flatMap(([key, value]) =>
      [value].flat().map((v) => `${key}: ${v}`),
    );
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

// --- 全体の流れ ---

let resetting = null;
function reset() {
  resetting ??= (async () => {
    log('データを初期状態に戻しています（AIワーカーはそのまま）…');
    try {
      await bootApp();
      log('やり直し完了。ブラウザは自動で開き直します。');
    } catch (error) {
      state.phase = 'failed';
      log(error.message);
    } finally {
      resetting = null;
    }
  })();
  return resetting;
}

function shutdown() {
  killTree(app);
  killTree(worker);
  rm(PID_FILE, { force: true }).finally(() => process.exit(0));
}

/** 発表者の画面を、ふだんのブラウザと分けた Edge のアプリ表示で開く（ブックマークや拡張・ログインを映さない） */
function openPresenter() {
  const url = `http://${HOME}/`;
  if (process.platform !== 'win32') return log(`ブラウザで ${url} を開いてください`);
  const profile = join(process.env.LOCALAPPDATA ?? tmpdir(), 'nicomaru-demo-edge');
  spawn(
    'cmd',
    [
      '/c',
      'start',
      '',
      'msedge',
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { stdio: 'ignore', detached: true },
  ).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// ウィンドウを閉じたとき（Windows は SIGHUP が届く）も子プロセスを残さない
process.on('SIGHUP', shutdown);

await new Promise((resolve, reject) => {
  server.once('error', (error) =>
    reject(
      new Error(
        `${PORT}番を使えません（${error.code}）。前の demo:all が残っていないか確認してください`,
      ),
    ),
  );
  server.listen(PORT, '127.0.0.1', resolve);
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
// ブラウザは *.localhost を ::1 で引くことがあるので、IPv6 のループバックでも受ける（無ければ諦める）
createServer(server.listeners('request')[0])
  .on('upgrade', server.listeners('upgrade')[0])
  .on('error', () => undefined)
  .listen(PORT, '::1');

// AIデモを終わる.bat がこのプロセスごと止めるための目印
await mkdir('.wrangler', { recursive: true });
await writeFile(PID_FILE, String(process.pid));
try {
  log('データを初期化してアプリを起動しています…');
  app = startApp();
  await waitReady(app);
  log('AIワーカーを起動し、LLMにつないでいます…');
  const [aiReady] = await Promise.all([
    startWorker(),
    (async () => {
      log('画面を準備しています…');
      await warmUp();
    })(),
  ]);
  state.ai = aiReady ? 'ready' : 'stopped';
  state.phase = 'ready';
} catch (error) {
  console.error(`[demo:all] ${error.message}`);
  shutdown();
}

console.log(`
==================================================
 ${state.ai === 'ready' ? '準備完了' : '準備完了（ただしAIはつながっていません。上の [AI] の行を確認）'}
 発表者の画面（Chrome か Edge）: http://${HOME}/
 ・「投影を開始」で投影用のウィンドウが開く。プロジェクター側へ移してダブルクリックで全画面
 ・投影にはデモの部分だけが映り、右の台本と上のボタンは映らない
 ・やり直し: 画面の「やり直す」か、ここで r と Enter
 ・終了: Ctrl+C（または AIデモを終わる.bat）
==================================================`);
if (OPEN) openPresenter();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'r') reset();
  if (line.trim() === 'q') shutdown();
});
