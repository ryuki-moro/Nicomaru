// AIデモを始める.bat / AIデモを終わる.bat の中身（bat に日本語を書くと cmd が文字コードを取り違えるため、こちらに置く）。
//   node scripts/demo-launch.mjs start  … npm run demo:all を最小化したウィンドウで起動し、準備ができたら発表者の画面を開く
//   node scripts/demo-launch.mjs stop   … 起動したアプリ・AIワーカーをまとめて止める
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

const PID_FILE = '.wrangler/demo-all.pid';
const CONNECTION_FILE = '.ai-lab-connection';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 目印のプロセスがまだ動いているAIデモか（落ちたあとに目印だけ残り、番号が別のプロセスに使い回されることがある） */
async function runningPid() {
  const pid = Number(await readFile(PID_FILE, 'utf8').catch(() => ''));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { stdout = '' } = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ],
    { encoding: 'utf8' },
  );
  if (stdout.includes('demo-all.mjs')) return pid;
  await rm(PID_FILE, { force: true });
  return null;
}

async function start() {
  if (!existsSync('node_modules')) {
    console.log('初回の準備をしています（npm ci、数分かかります）…');
    if (spawnSync('npm', ['ci'], { stdio: 'inherit', shell: true }).status !== 0) {
      console.error('npm ci に失敗しました。');
      return 1;
    }
  }
  if (await runningPid()) {
    console.error('前のAIデモが動いています。先に AIデモを終わる.bat を実行してください。');
    return 1;
  }
  // 接続先が未設定なら1回だけ聞いて .ai-lab-connection（git管理外）に覚える
  if (!process.env.OLLAMA_ENDPOINT && !existsSync(CONNECTION_FILE)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('ai-agent-lab の「外部連携」でコピーした接続コードを貼り付けて Enter。');
    console.log('このPCの Ollama を使うときは local と入力。');
    const code = (await rl.question('接続コード: ')).trim();
    rl.close();
    if (!code) {
      console.error('接続コードが空です。');
      return 1;
    }
    await writeFile(CONNECTION_FILE, code, { mode: 0o600 });
  }
  spawn(
    'cmd',
    [
      '/c',
      'start',
      'にこまる AIデモ（閉じると終了）',
      '/min',
      'cmd',
      '/c',
      'npm run demo:all -- --open || pause',
    ],
    { stdio: 'ignore', detached: true },
  ).unref();
  console.log('起動しています。約30秒で発表者の画面が開きます。');
  console.log(
    '開かないときは、タスクバーの「にこまる AIデモ」のウィンドウでエラーを確認してください。',
  );
  await pause(5000);
  return 0;
}

async function stop() {
  const pid = await runningPid();
  if (!pid) console.log('動いているAIデモはありません。');
  else {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    await rm(PID_FILE, { force: true });
    console.log('AIデモを終了しました。');
  }
  await pause(3000);
  return 0;
}

const command = process.argv[2];
process.exitCode = command === 'start' ? await start() : command === 'stop' ? await stop() : 1;
