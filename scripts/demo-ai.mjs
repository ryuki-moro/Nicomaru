// npm run demo:ai — npm run demo（3105）へAIワーカーをつなぐ。トークンは demo と同じ秘密値から導くので、手で設定する値は無い。
// 接続先は次の順に決める：環境変数 OLLAMA_ENDPOINT → --connect の値 → .ai-lab-connection（git管理外）→ このPCの Ollama。
//   --connect "<接続コード>"  ai-agent-lab の「外部連携」で発行したコード（aal://HOST:PORT?model=..&key=..）
//   --connect local           ai-agent-lab を使わず、このPCの Ollama に直接つなぐ（local?model=qwen2.5:7b も可）
// 一度渡した値は .ai-lab-connection に覚え、次からは npm run demo:ai だけで同じ相手につなぐ。
import { spawn } from 'node:child_process';
import { hkdfSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CONNECTION_FILE = '.ai-lab-connection';
const LOCAL_OLLAMA = 'http://127.0.0.1:11434';

/** 接続コード → Ollama 互換の接続先 */
export function parseConnectionCode(code) {
  const text = code.trim();
  const local = /^local(?:\?(.*))?$/.exec(text);
  if (local) {
    const model = new URLSearchParams(local[1] ?? '').get('model') ?? undefined;
    return { endpoint: LOCAL_OLLAMA, model, label: 'このPCの Ollama' };
  }
  const url = new URL(text.replace(/^aal:/, 'http:'));
  const key = url.searchParams.get('key');
  if (!text.startsWith('aal://') || !url.hostname || !key)
    throw new Error('接続コードの形式が正しくありません（aal://… か local）');
  // 窓口は http のため、通信路が暗号化される Tailscale（100.64.0.0/10）かこのPC内だけに送る
  const [a, b] = url.hostname.split('.').map(Number);
  const tailscale = a === 100 && b >= 64 && b <= 127;
  if (!tailscale && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(`接続先 ${url.hostname} は Tailscale（100.64.0.0/10）でもこのPCでもありません`);
  return {
    endpoint: `http://${url.host}`,
    key,
    model: url.searchParams.get('model') ?? undefined,
    label: 'ai-agent-lab の生成窓口',
  };
}

/** 接続先とモデルを確かめ、つながらない原因を日本語1行で返す（つながれば null） */
export async function diagnose(endpoint, model, headers) {
  let response;
  try {
    response = await fetch(`${endpoint}/api/tags`, { headers, signal: AbortSignal.timeout(5000) });
  } catch {
    return `LLM（${endpoint}）に届きません。相手のPCの起動・Tailscale・窓口（llm_gateway.py / Ollama）を確認してください。`;
  }
  if (response.status === 401 || response.status === 403)
    return `LLM（${endpoint}）の合言葉が違います。ai-agent-lab で接続コードを発行し直し、--connect で渡してください。`;
  if (!response.ok) return `LLM（${endpoint}）がエラーを返しました（${response.status}）。`;
  const { models = [] } = await response.json().catch(() => ({}));
  if (!models.some((m) => m.name === model || m.name === `${model}:latest`))
    return `LLM（${endpoint}）にモデル ${model} がありません（入っているもの: ${models.map((m) => m.name).join(', ') || 'なし'}）。`;
  return null;
}

async function main() {
  const argIndex = process.argv.indexOf('--connect');
  let code = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;
  if (argIndex >= 0 && !code) {
    console.error(
      '--connect のあとに、ai-agent-lab で発行した接続コードか local を付けてください。',
    );
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
    console.error('先に npm run demo（または npm run demo:all）を起動してください。');
    process.exit(1);
  }
  const endpoint = process.env.OLLAMA_ENDPOINT ?? saved.endpoint ?? LOCAL_OLLAMA;
  const model = process.env.OLLAMA_MODEL ?? saved.model ?? 'gemma3:12b';
  // 別のPCのOllamaを鍵付きで公開している場合（ワーカー本体と同じ OLLAMA_API_KEY を使う）
  const apiKey = process.env.OLLAMA_API_KEY ?? saved.key;
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  console.log(
    `接続先: ${saved.label ?? (process.env.OLLAMA_ENDPOINT ? 'OLLAMA_ENDPOINT' : 'このPCの Ollama')}（${endpoint}）／モデル: ${model}`,
  );
  const problem = await diagnose(endpoint, model, headers);
  if (problem) {
    console.error(problem);
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
      // 依頼が来たらすぐ拾う（同じPC内のアプリへの問い合わせなので、本番の30秒より短くしてよい）
      AI_WORKER_POLL_MS: process.env.AI_WORKER_POLL_MS ?? '300',
    },
  });
  child.on('exit', (exitCode) => process.exit(exitCode ?? 1));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
