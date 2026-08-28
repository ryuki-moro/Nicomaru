/**
 * AIジョブワーカー（機能9-6、Phase 3）。
 *
 * 正本: 基本設計書 Version 1.2 7-3「ジョブキュー・処理アーキテクチャ」／7-6「内製AIアシスタント基盤」。
 *
 *   「ローカルLLMサーバー上で稼働するTypeScript（Node.js）プロセス。
 *     ジョブ取得→プロンプト構築→Ollama呼び出し→出力検証→結果書き込みを担う。多重起動可」
 *   「受け渡しはプル型（ワーカーからのアウトバウンド接続のみ）とし、
 *     ローカルLLMサーバーを外部公開しない」
 *   「ポーリング間隔は30秒」
 *   「ワーカーには Service Role Key を配布せず、ジョブ取得と結果書き込みのみを許す
 *     security definer RPC を用意し、ワーカー専用DBロールに EXECUTE を付与する」
 *
 * 【なぜアプリ本体と別プロセスなのか】
 * 推論は数十秒かかることがあり、Vercel のサーバーレス実行時間に収まらない（2-2-1）。
 * また GPU は校内・自宅のPCにしかない。だから「アプリが呼びに行く」のではなく
 * 「GPUのある側が取りに来る」向きにする。この向きなら、
 * ローカルLLMサーバーを外部公開せずに済む（7-1 のデータ保護とも整合する）。
 *
 * 起動:
 *   AI_WORKER_DATABASE_URL=postgres://ai_worker:<pw>@<host>:5432/postgres \
 *   OLLAMA_ENDPOINT=http://localhost:11434 \
 *   npx tsx worker/ai-worker.ts
 */
import { hostname } from 'node:os';

import { Client } from 'pg';

import { AI_JOB_TYPES, validateAiOutput, type AiJobType } from '../src/lib/ai/schemas';

/** 7-3「ポーリング間隔は30秒」。 */
const POLL_INTERVAL_MS = 30_000;
/** ジョブが無いときに待つ時間。空振りでログを埋めないよう間隔は同じにする。 */
const IDLE_INTERVAL_MS = POLL_INTERVAL_MS;

/**
 * 7-6「job_type ごとに使用モデルを設定で切り替え可能とする」の既定値。
 *
 * 13-1 の開発チーム決定により既定は gemma3:12b。
 * ローカル環境で 9-1 分類と 9-5 起票案を実際に流し、
 * 7-2 のJSONスキーマに適合する出力が返ることを確認して選んだ。
 * VRAM が足りない環境では OLLAMA_MODEL=qwen2.5:7b を渡す。
 * job_type ごとの切り替えは ai_prompt_templates.model_name（DB管理）が優先される。
 */
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:12b';

interface ClaimedJob {
  id: string;
  job_type: AiJobType;
  venue_id: string;
  case_id: string | null;
  related_task_id: string | null;
  input_ref: { ref?: { table: string; id: string }; text?: string; params?: Record<string, unknown> };
  model_name: string | null;
  prompt_text: string | null;
  prompt_template_id: string | null;
  attempts: number;
}

const workerId = `${hostname()}:${process.pid}`;
let stopping = false;

function log(message: string, extra?: unknown) {
  // 本文や個人情報は出さない（7-4）。出すのは job_type と id まで。
  console.log(`[ai-worker ${workerId}] ${message}`, extra ?? '');
}

/**
 * Ollama を呼ぶ（7-6 生成エンジン）。
 *
 * format: 'json' を付けるのは、出力を zod で検証する前提だから（7-6 出力検証）。
 * 自由文で返させると検証がほぼ必ず落ち、リトライを空振りさせる。
 */
async function callOllama(model: string, prompt: string, input: string): Promise<unknown> {
  const endpoint = process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434';
  const apiKey = process.env.OLLAMA_API_KEY;

  const response = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      prompt: `${prompt}\n\n---\n${input}`,
      format: 'json',
      stream: false,
      options: { temperature: 0.2 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama がエラーを返しました: ${response.status}`);
  }
  const body = (await response.json()) as { response?: string };
  if (!body.response) throw new Error('Ollama の応答が空でした');

  try {
    return JSON.parse(body.response);
  } catch {
    throw new Error('Ollama の出力がJSONとして読めませんでした');
  }
}

/**
 * LLM へ渡す入力を組み立てる。
 *
 * 7-4「LLMへの入力は処理に必要な最小限の項目に限定する」。
 * input_ref.text（マスク済み）だけを渡し、参照先の本文を勝手に読みにいかない。
 * 参照先を読む必要がある job_type は、投入側が必要な分を text に入れて渡す。
 */
function buildInput(job: ClaimedJob): string {
  const parts: string[] = [];
  if (job.input_ref?.text) parts.push(job.input_ref.text);
  if (job.input_ref?.params && Object.keys(job.input_ref.params).length > 0) {
    parts.push(`パラメータ: ${JSON.stringify(job.input_ref.params)}`);
  }
  return parts.join('\n\n');
}

async function processJob(client: Client, job: ClaimedJob): Promise<void> {
  const model = job.model_name ?? DEFAULT_MODEL;

  // プロンプトは ai_prompt_templates（DB管理）から来る（7-6）。
  // 見つからない場合はコードに埋め込んだ文言で代用せず、失敗させて設定漏れを表面化させる。
  if (!job.prompt_text) {
    await client.query('select complete_ai_job($1, $2, null, $3, $4)', [
      job.id, workerId,
      `job_type=${job.job_type} の有効なプロンプトテンプレートがありません`,
      model,
    ]);
    log('プロンプト未設定のため failed', { id: job.id, jobType: job.job_type });
    return;
  }

  try {
    const raw = await callOllama(model, job.prompt_text, buildInput(job));

    // 7-6「ワーカーはLLM出力をJSONスキーマで検証してから ai_jobs.output に保存する」
    const validated = validateAiOutput(job.job_type, raw);
    if (!validated.ok) {
      // 検証失敗はリトライの対象（上限を超えたら滞留回収が failed にする）。
      // ここで failed を書かずに processing のまま抜けると、
      // locked_at 超過で queued へ戻り、attempts が加算される（7-3）。
      log('出力がスキーマに合いませんでした。再試行に回します', {
        id: job.id, error: validated.error,
      });
      return;
    }

    await client.query('select complete_ai_job($1, $2, $3::jsonb, null, $4)', [
      job.id, workerId, JSON.stringify(validated.value), model,
    ]);
    log('完了', { id: job.id, jobType: job.job_type });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // 試行上限に達していれば failed として確定させ、画面を手動運用へ倒す（7-1）。
    // 達していなければ processing のまま抜け、滞留回収で queued へ戻す。
    if (job.attempts >= 3) {
      await client.query('select complete_ai_job($1, $2, null, $3, $4)', [
        job.id, workerId, message, model,
      ]);
      log('試行上限のため failed', { id: job.id, message });
    } else {
      log('失敗。再試行に回します', { id: job.id, message });
    }
  }
}

async function main(): Promise<void> {
  const url = process.env.AI_WORKER_DATABASE_URL;
  if (!url) {
    console.error('AI_WORKER_DATABASE_URL が設定されていません。'
      + 'ワーカー専用ロール（ai_worker）の接続情報を渡してください（7-3）。');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  log('起動しました', { models: DEFAULT_MODEL });

  const shutdown = () => {
    stopping = true;
    log('停止要求を受けました。処理中のジョブを終えてから終了します');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!stopping) {
    try {
      // 心拍。7-3 (4)「『利用不可』表示は、最終ポーリングから10分以上経過したことを
      // 判定条件とする」。ジョブの有無に関わらず毎回打つ。
      // ジョブが無い間は locked_at が動かないので、それでは「暇」と「停止」を区別できない。
      await client.query('select ai_worker_ping($1, $2)', [workerId, DEFAULT_MODEL]);

      const claimed = await client.query<ClaimedJob>(
        'select * from claim_ai_job($1, $2)',
        [workerId, AI_JOB_TYPES as unknown as string[]],
      );

      if (claimed.rows.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_INTERVAL_MS));
        continue;
      }

      await processJob(client, claimed.rows[0]);
      // ジョブがあった直後は続けて取りに行く（滞留を減らす）
    } catch (error) {
      // 接続断などはここで拾う。落としてしまうと再起動まで止まる。
      log('ループでエラーが発生しました', error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  await client.end();
  log('終了しました');
}

main().catch((error) => {
  console.error('[ai-worker] 起動に失敗しました', error);
  process.exit(1);
});
