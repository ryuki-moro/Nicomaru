// npm run demo:ai — npm run demo（3105）へAIワーカーをつなぐ。Ollama の場所は OLLAMA_ENDPOINT（既定は同じPC）。
// トークンは demo と同じ秘密値から導くので、手で設定する値は無い（モデルは OLLAMA_MODEL で変更可）。
// ai-agent-lab の「外部連携」で発行した接続コードは --connect <コード> で渡す。一度渡したコードは
// .ai-lab-connection（git管理外）に覚え、次からは npm run demo:ai だけで同じ相手につなぐ。
import { spawn } from 'node:child_process';
import { hkdfSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const CONNECTION_FILE = '.ai-lab-connection';
/** aal://HOST:PORT?model=...&key=... → Ollama 互換の接続先 */
function parseConnectionCode(code) {
  const url = new URL(code.trim().replace(/^aal:/, 'http:'));
  const key = url.searchParams.get('key');
  if (!url.hostname || !key) throw new Error('接続コードの形式が正しくありません');
  // 窓口は http のため、通信路が暗号化される Tailscale（100.64.0.0/10）かこのPC内だけに送る
  const [a, b] = url.hostname.split('.').map(Number);
  const tailscale = a === 100 && b >= 64 && b <= 127;
  if (!tailscale && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(`接続先 ${url.hostname} は Tailscale（100.64.0.0/10）でもこのPCでもありません`);
  return {
    endpoint: `http://${url.host}`,
    key,
    model: url.searchParams.get('model') ?? undefined,
  };
}
const argIndex = process.argv.indexOf('--connect');
let code = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;
if (argIndex >= 0 && !code) {
  console.error('--connect のあとに、ai-agent-lab で発行した接続コードを付けてください。');
  process.exit(1);
}
const fromArg = Boolean(code);
code ??= await readFile(CONNECTION_FILE, 'utf8').catch(() => undefined);
let saved = {};
// OLLAMA_ENDPOINT を直接指定したときは、保存した接続コード（別の相手の合言葉）を使わない
if (code && !process.env.OLLAMA_ENDPOINT) {
  try {
    saved = parseConnectionCode(code);
  } catch (error) {
    console.error(
      `${error.message}（${fromArg ? '--connect の値' : CONNECTION_FILE} を確認してください）`,
    );
    process.exit(1);
  }
  // 読み取れたコードだけを覚える（崩れたコードを保存して次回以降も失敗し続けないように）
  if (fromArg) await writeFile(CONNECTION_FILE, code.trim(), { mode: 0o600 });
}

let secret;
try {
  secret = await readFile('.wrangler/demo/auth-secret', 'utf8');
} catch {
  console.error('先に別のターミナルで npm run demo を起動してください。');
  process.exit(1);
}
// 環境変数が指定されていればそちらを優先する（これまでの指定方法）
const endpoint = process.env.OLLAMA_ENDPOINT ?? saved.endpoint ?? 'http://localhost:11434';
const model = process.env.OLLAMA_MODEL ?? saved.model ?? 'gemma3:12b';
// 別のPCのOllamaを鍵付きで公開している場合（ワーカー本体と同じ OLLAMA_API_KEY を使う）
const apiKey = process.env.OLLAMA_API_KEY ?? saved.key;
const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
if (saved.endpoint) console.log(`接続コードの相手（${endpoint}）につなぎます。`);
try {
  const { models } = await (await fetch(`${endpoint}/api/tags`, { headers })).json();
  if (!models.some((m) => m.name === model || m.name === `${model}:latest`)) {
    console.error(
      `Ollama に ${model} がありません。ollama pull ${model} を実行するか、OLLAMA_MODEL で入っているモデルを指定してください。`,
    );
    console.error(`入っているモデル: ${models.map((m) => m.name).join(', ') || 'なし'}`);
    process.exit(1);
  }
} catch {
  console.error(
    `Ollama（${endpoint}）につながりません。起動・URL・OLLAMA_API_KEY を確認してください。`,
  );
  process.exit(1);
}
// デモ中にモデルが外れて最初の依頼だけ遅くならないよう、先に読み込んで保持させる。
// プロンプト無しの読み込みは文脈長などの設定が本番の依頼と異なり読み込み直しになりうるため、
// 本番と同じ形の短い生成を1回流す
const keepAlive = process.env.OLLAMA_KEEP_ALIVE ?? '60m';
console.log(`${model} を読み込んでいます…`);
const loaded = await fetch(`${endpoint}/api/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({
    model,
    prompt: '{"ok": true} とだけ返してください。',
    format: 'json',
    stream: false,
    options: { temperature: 0.2 },
    keep_alive: keepAlive,
  }),
}).catch(() => null);
if (!loaded?.ok) console.warn('モデルの事前読み込みに失敗しました（最初の依頼が遅くなります）。');
const child = spawn(process.execPath, ['--import', 'tsx', 'worker/ai-worker.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    AI_WORKER_API_URL: 'http://127.0.0.1:3105',
    AI_WORKER_TOKEN: Buffer.from(
      hkdfSync('sha256', Buffer.from(secret, 'hex'), '', 'nicomaru-local-ai-worker', 32),
    ).toString('base64url'),
    OLLAMA_ENDPOINT: endpoint,
    ...(apiKey ? { OLLAMA_API_KEY: apiKey } : {}),
    OLLAMA_MODEL: model,
    OLLAMA_KEEP_ALIVE: keepAlive,
    AI_WORKER_POLL_MS: process.env.AI_WORKER_POLL_MS ?? '2000',
  },
});
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGINT'));
