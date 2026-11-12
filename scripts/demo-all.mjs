// npm run demo:all — AIデモの準備を1コマンドで終える（#238・#239）。
//   1. デモのデータを初期化してアプリを起動（npm run demo -- --reset と同じ）
//   2. AIワーカーを起動し、LLMとの疎通とモデルの読み込みまで済ませる（npm run demo:ai と同じ。引数はそのまま渡す）
//   3. プランナーと新郎新婦を左右に並べる画面を http://demo.localhost:3106/ で開けるようにする
// 左右で別々にログインできるよう、ホスト名を分けた中継（p.demo.localhost / c.demo.localhost）を挟む。
// Cookie はホスト名ごとに保持されるので、同じブラウザでも互いのログインを上書きしない。
// 中継はこのPCのループバックだけで待ち受け、アプリ側（本番の画面・API）には手を入れない。
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const APP = 'http://127.0.0.1:3105';
const APP_HOST = '127.0.0.1:3105';
const PORT = 3106;
const HOME = `demo.localhost:${PORT}`;
const ROLE_HOST = {
  [`p.demo.localhost:${PORT}`]: 'planner',
  [`c.demo.localhost:${PORT}`]: 'couple',
};
const HOST_OF = { planner: `p.demo.localhost:${PORT}`, couple: `c.demo.localhost:${PORT}` };

const state = { phase: 'starting', ai: 'starting', coupleUrl: '/mypage', scenes: null };
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
  const planner = cookieHeader(await demoSignIn('planner'));
  const couple = cookieHeader(await demoSignIn('couple'));
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
  const child = spawn(process.execPath, ['scripts/demo-ai.mjs', ...process.argv.slice(2)], {
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

const loginQueue = { planner: Promise.resolve(), couple: Promise.resolve() };

/** /__demo/login?next=/path — ログイン済みならそのまま、未ログインならデモのアカウントでログインして開く */
async function handleLogin(req, res, role, url) {
  const next = url.searchParams.get('next') ?? '/';
  // 同じホスト内のパスだけ（//host や /\host は別サイトへ飛ぶため拒否）
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return send(res, 400, 'next が不正です');
  const run = loginQueue[role].then(async () => {
    const current = await fetch(`${APP}${next}`, {
      headers: { cookie: req.headers.cookie ?? '' },
      redirect: 'manual',
    }).catch(() => undefined);
    const setCookies = current?.status === 200 ? [] : await demoSignIn(role);
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
  if (url.pathname === '/' && req.method === 'GET')
    return send(res, 200, page(), 'text/html; charset=utf-8');
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
  if (host === HOME) return void handleHome(req, res, url);
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

function page() {
  const login = (role, next) =>
    `http://${HOST_OF[role]}/__demo/login?next=${encodeURIComponent(next)}`;
  const scenes = state.scenes ?? {};
  const tabs = [
    ['meeting', '① 打ち合わせ記録'],
    ['guests', '② ゲストリスト'],
    ['bgm', '③ BGMリクエスト'],
  ];
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>AIデモ（左右並べ）</title>
<style>
  :root { color-scheme: light; --bg:#f4f1ec; --bar:#2b2622; --ink:#fff; --accent:#c8956d; }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column; background:var(--bg);
         font-family: system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif; }
  header { display:flex; gap:8px; align-items:center; padding:8px 12px; background:var(--bar); color:var(--ink); }
  header button { font:inherit; font-size:14px; padding:6px 12px; border-radius:6px; border:1px solid #6b625b;
                  background:transparent; color:var(--ink); cursor:pointer; }
  header button[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:#1d1915; font-weight:700; }
  header .spacer { flex:1; }
  #status { font-size:13px; opacity:.85; }
  main { flex:1; display:flex; gap:16px; padding:12px; min-height:0; }
  #left { flex:1; position:relative; border-radius:8px; overflow:hidden; background:#fff; box-shadow:0 1px 4px #0002; }
  #left iframe { position:absolute; inset:0; width:100%; height:100%; border:0; visibility:hidden; }
  #left iframe.active { visibility:visible; }
  #right { width:430px; display:flex; flex-direction:column; align-items:center; gap:6px; padding:0 12px; }
  #right .label { font-size:13px; color:#5c534c; }
  #phone { width:390px; flex:1; border:10px solid #1d1915; border-radius:28px; overflow:hidden; background:#fff; }
  #phone iframe { width:100%; height:100%; border:0; }
</style></head><body>
<header>
  ${tabs.map(([key, label], i) => `<button data-scene="${key}" aria-pressed="${i === 0}">${label}</button>`).join('')}
  <span class="spacer"></span>
  <span id="status"></span>
  <button id="refresh" title="新郎新婦の画面を開き直します">新郎新婦の画面を更新</button>
  <button id="reset" title="データを初期状態に戻します（AIワーカーはそのまま）">最初からやり直す</button>
</header>
<main>
  <div id="left">
    ${tabs.map(([key], i) => `<iframe title="プランナー ${key}" data-scene="${key}" data-src="${login('planner', scenes[key] ?? '/')}" class="${i === 0 ? 'active' : ''}"></iframe>`).join('')}
  </div>
  <div id="right"><span class="label">新郎新婦のスマホ</span>
    <div id="phone"><iframe id="couple" title="新郎新婦"></iframe></div>
  </div>
</main>
<script>
  const frames = [...document.querySelectorAll('#left iframe')];
  const couple = document.getElementById('couple');
  const status = document.getElementById('status');
  const coupleLogin = (next) => ${JSON.stringify(`http://${HOST_OF.couple}/__demo/login?next=`)} + encodeURIComponent(next);
  // 同じ人の3画面を順に開く（同時に開くとログインが重なるため）
  function loadAll() {
    frames.reduce((p, f) => p.then(() => new Promise((done) => { f.onload = done; f.src = f.dataset.src; })), Promise.resolve())
      .then(() => { couple.src = coupleLogin('/mypage'); });
  }
  document.querySelectorAll('header [data-scene]').forEach((b) => b.onclick = () => {
    document.querySelectorAll('header [data-scene]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    frames.forEach((f) => f.classList.toggle('active', f.dataset.scene === b.dataset.scene));
  });
  async function refreshCouple() {
    const s = await fetch('/__demo/state').then((r) => r.json());
    couple.src = coupleLogin(s.coupleUrl);
    dirty = false;
  }
  document.getElementById('refresh').onclick = refreshCouple;
  // 左を操作したあと右へ目を移したら（マウスが右に入ったら）、右を自動で開き直す
  let dirty = false;
  setInterval(() => { if (frames.includes(document.activeElement)) dirty = true; }, 300);
  document.getElementById('right').addEventListener('pointerenter', () => { if (dirty) refreshCouple(); });
  document.getElementById('reset').onclick = async () => {
    if (!confirm('データを初期状態に戻します。よろしいですか？')) return;
    await fetch('/__demo/reset', { method: 'POST' });
    status.textContent = 'やり直し中…';
    let phase = 'resetting';
    while (phase === 'resetting') {
      await new Promise((r) => setTimeout(r, 1000));
      phase = await fetch('/__demo/state').then((r) => r.json()).then((s) => s.phase).catch(() => 'resetting');
    }
    if (phase === 'ready') location.reload();
    else alert('やり直しに失敗しました。demo:all のターミナルを確認し、起動し直してください。');
  };
  setInterval(async () => {
    const s = await fetch('/__demo/state').then((r) => r.json()).catch(() => null);
    if (!s) { status.textContent = 'demo:all が止まっています'; return; }
    status.textContent = s.phase === 'failed' ? 'やり直しに失敗（ターミナルを確認）' : s.phase !== 'ready' ? 'やり直し中…' : s.ai === 'ready' ? 'AI：接続中' : 'AI：未接続（手入力で続けられます）';
  }, 2000);
  loadAll();
</script></body></html>`;
}

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
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
 Chrome か Edge で開く: http://${HOME}/
 ・上のボタンで場面を切り替え、右に新郎新婦のスマホ画面が出ます
 ・やり直し: 画面の「最初からやり直す」か、ここで r と Enter
 ・終了: Ctrl+C
==================================================`);
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'r') reset();
  if (line.trim() === 'q') shutdown();
});
