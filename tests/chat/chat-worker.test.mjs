import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { unstable_startWorker as startWorker } from 'wrangler';
import WebSocket from 'ws';
import { internalNotifyToken, signTicket } from '../../src/lib/chat/ticket.ts';

const SECRET = 'test-secret-0123456789abcdef';
const ORIGIN = 'https://app.test';
const now = () => Math.floor(Date.now() / 1000);

let worker, base;
const sockets = [];

before(async () => {
  worker = await startWorker({
    config: 'cloudflare/chat/wrangler.jsonc',
    bindings: {
      CHAT_TICKET_SECRET: { type: 'secret_text', value: SECRET },
      APP_BASE_URL: { type: 'plain_text', value: ORIGIN },
    },
    dev: { persist: false, server: { port: 0 }, logLevel: 'error' },
  });
  await worker.ready;
  base = new URL(await worker.url);
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  await worker?.dispose();
});

const ticketFor = (caseId, userId = 'u1', exp = now() + 60) =>
  signTicket(SECRET, { caseId, userId, exp });

/** 接続を試み、開けば ws を、拒否されれば HTTP ステータスを返す。 */
function connect(ticket, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base.host}/ws?ticket=${encodeURIComponent(ticket)}`, {
      headers: origin ? { Origin: origin } : {},
    });
    sockets.push(ws);
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    ws.once('error', (e) => (e.message.includes('Unexpected server response') ? null : reject(e)));
  });
}

const nextMessage = (ws, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(t);
      resolve(data.toString());
    });
  });

const noMessage = (ws, ms = 500) =>
  new Promise((resolve, reject) => {
    const onMsg = () => reject(new Error('unexpected message'));
    ws.once('message', onMsg);
    setTimeout(() => {
      ws.off('message', onMsg);
      resolve();
    }, ms);
  });

async function notify(signal, token) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null)
    headers['x-chat-internal-token'] = token ?? (await internalNotifyToken(SECRET));
  return fetch(`http://${base.host}/notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify(signal),
  });
}

test('有効なチケットで接続できる', async () => {
  const { ws, status } = await connect(await ticketFor('case-ok'));
  assert.equal(status, undefined);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('期限切れ・改ざん・欠落のチケットは401', async () => {
  const expired = await ticketFor('case-x', 'u1', now() - 1);
  assert.equal((await connect(expired)).status, 401);
  const good = await ticketFor('case-x');
  const [p, s] = good.split('.');
  assert.equal((await connect(`${p}x.${s}`)).status, 401);
  assert.equal((await connect('')).status, 401);
});

test('Origin が違う・無いと403', async () => {
  const t = await ticketFor('case-x');
  assert.equal((await connect(t, 'https://evil.test')).status, 403);
  assert.equal((await connect(t, null)).status, 403);
});

test('WebSocket でない要求は426', async () => {
  const res = await fetch(`http://${base.host}/ws?ticket=x`, { headers: { Origin: ORIGIN } });
  assert.equal(res.status, 426);
});

test('未知のパスは404', async () => {
  assert.equal((await fetch(`http://${base.host}/nope`)).status, 404);
});

test('/notify はトークン無し・誤りで401、不正な本文は400', async () => {
  const signal = { type: 'message', caseId: 'c', cursor: '1', senderUserId: 'u1' };
  assert.equal((await notify(signal, null)).status, 401);
  assert.equal((await notify(signal, 'wrong')).status, 401);
  assert.equal((await notify({ type: 'x', caseId: 'c' })).status, 400);
});

test('/notify は同じ案件の接続だけに合図を届ける', async () => {
  const a1 = (await connect(await ticketFor('case-A', 'u1'))).ws;
  const a2 = (await connect(await ticketFor('case-A', 'u2'))).ws;
  const b = (await connect(await ticketFor('case-B', 'u3'))).ws;
  const signal = { type: 'message', caseId: 'case-A', cursor: '42', senderUserId: 'u1' };
  const got = Promise.all([nextMessage(a1), nextMessage(a2)]);
  const other = noMessage(b);
  assert.equal((await notify(signal)).status, 204);
  for (const m of await got) assert.deepEqual(JSON.parse(m), signal);
  await other;
});

test('ping に pong を返す', async () => {
  const { ws } = await connect(await ticketFor('case-ping'));
  const reply = nextMessage(ws);
  ws.send('ping');
  assert.equal(await reply, 'pong');
});

test('21本目の接続は429で拒否される', async () => {
  const opened = [];
  for (let i = 0; i < 20; i++) {
    const r = await connect(await ticketFor('case-full', `u${i}`));
    assert.ok(r.ws, `接続${i + 1}本目が開く`);
    opened.push(r.ws);
  }
  assert.equal((await connect(await ticketFor('case-full', 'u20'))).status, 429);
});
