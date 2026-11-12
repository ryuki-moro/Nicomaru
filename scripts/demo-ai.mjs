// npm run demo:ai — npm run demo（3105）へAIワーカーをつなぐ。Ollama の場所は OLLAMA_ENDPOINT（既定は同じPC）。
// トークンは demo と同じ秘密値から導くので、手で設定する値は無い（モデルは OLLAMA_MODEL で変更可）。
import { spawn } from 'node:child_process';
import { hkdfSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

let secret;
try {
  secret = await readFile('.wrangler/demo/auth-secret', 'utf8');
} catch {
  console.error('先に別のターミナルで npm run demo を起動してください。');
  process.exit(1);
}
const endpoint = process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434';
const model = process.env.OLLAMA_MODEL ?? 'gemma3:12b';
// 別のPCのOllamaを鍵付きで公開している場合（ワーカー本体と同じ OLLAMA_API_KEY を使う）
const headers = process.env.OLLAMA_API_KEY
  ? { authorization: `Bearer ${process.env.OLLAMA_API_KEY}` }
  : {};
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
    OLLAMA_MODEL: model,
    OLLAMA_KEEP_ALIVE: keepAlive,
    AI_WORKER_POLL_MS: process.env.AI_WORKER_POLL_MS ?? '2000',
  },
});
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGINT', () => child.kill('SIGINT'));
