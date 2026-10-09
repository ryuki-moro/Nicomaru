/**
 * CI の使い捨てローカル Supabase 専用の模擬ワーカー。
 * 推論は呼ばず、実ワーカーと同じ ai_worker 権限で RPC だけを実行する。
 */
import { Client } from 'pg';

import { validateAiOutput } from '../../../src/lib/ai/schemas';
import { e2eEnv } from './env';

interface ClaimedDraft {
  id: string;
  job_type: string;
  case_id: string;
  related_task_id: string | null;
  input_ref: { text?: string; params?: Record<string, unknown> };
  prompt_text: string | null;
  attempts: number;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function localUrl(value: string, protocols: string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('AI workflow E2E のローカル接続先が設定されていません');
  }
  if (!protocols.includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    // 接続 URL（認証情報を含み得る）はエラーへ出さない。
    throw new Error('AI workflow E2E は loopback の接続先だけで実行できます');
  }
  return url;
}

export async function connectLocalAiWorker(workerName: string) {
  if (!process.env.CI) throw new Error('AI workflow E2E は CI 専用です');
  localUrl(e2eEnv.supabaseUrl, ['http:']);
  localUrl(process.env.APP_BASE_URL ?? 'http://localhost:3000', ['http:']);
  const databaseUrl = localUrl(process.env.E2E_AI_DATABASE_URL ?? '', ['postgres:', 'postgresql:']);
  // supabase start の既知の接続に限定し、外部 DB の資格情報は使用しない。
  if (
    databaseUrl.username !== 'postgres' ||
    databaseUrl.password !== 'postgres' ||
    databaseUrl.pathname !== '/postgres' ||
    databaseUrl.search !== ''
  ) {
    throw new Error('AI workflow E2E には標準のローカル Supabase DB を指定してください');
  }

  const client = new Client({
    connectionString: databaseUrl.toString(),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  let identity: {
    connectionRole: string;
    workerRole: string;
    superuser: boolean;
    bypassRls: boolean;
  };
  try {
    await client.connect();
    const connection = await client.query<{
      session_user: string;
      current_user: string;
      can_set_worker: boolean;
    }>(
      `select session_user, current_user, pg_has_role(session_user, 'ai_worker', 'SET') as can_set_worker`,
    );
    const login = connection.rows[0];
    if (login?.session_user !== 'postgres' || login.current_user !== 'postgres') {
      throw new Error('AI E2E の接続ロールが想定する postgres ではありません');
    }
    if (!login.can_set_worker) {
      throw new Error('CI の postgres → ai_worker メンバーシップに SET TRUE が必要です');
    }
    // ai_worker は migration で NOLOGIN。CI の owner 接続を降格してから全操作する。
    await client.query('set role ai_worker');
    const role = await client.query<{
      session_user: string;
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select session_user, current_user, rolsuper, rolbypassrls
         from pg_roles where rolname = current_user`,
    );
    const worker = role.rows[0];
    if (
      worker?.session_user !== 'postgres' ||
      worker.current_user !== 'ai_worker' ||
      worker.rolsuper ||
      worker.rolbypassrls
    )
      throw new Error('ワーカー権限へ切り替わりませんでした');
    identity = {
      connectionRole: worker.session_user,
      workerRole: worker.current_user,
      superuser: worker.rolsuper,
      bypassRls: worker.rolbypassrls,
    };
  } catch (error) {
    await client.end();
    throw error;
  }

  return {
    identity,
    async deniesDirectAccess(): Promise<{ read: boolean; write: boolean }> {
      async function denied(sql: string): Promise<boolean> {
        try {
          await client.query(sql);
          return false;
        } catch (error) {
          if ((error as { code?: string }).code === '42501') return true;
          throw error;
        }
      }
      return {
        read: await denied('select id from public.user_profiles limit 0'),
        write: await denied('update public.ai_jobs set status = status where false'),
      };
    },
    async ping(): Promise<void> {
      await client.query('select public.ai_worker_ping($1, $2)', [workerName, 'e2e-fixture']);
    },
    async claimDraft(caseId: string, jobId: string): Promise<ClaimedDraft> {
      await client.query('begin');
      try {
        const claimed = await client.query<ClaimedDraft>(
          'select * from public.claim_ai_job($1, $2::text[])',
          [workerName, ['draft']],
        );
        const job = claimed.rows[0];
        if (claimed.rows.length !== 1 || job?.case_id !== caseId || job.id !== jobId) {
          // RPC は種別ごとの先頭を取る。別テストのジョブなら claim 自体を取り消す。
          throw new Error('対象 fixture の draft ジョブを取得できませんでした');
        }
        await client.query('commit');
        return job;
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    },
    async completeDraft(jobId: string, output: unknown): Promise<boolean> {
      const validated = validateAiOutput('draft', output);
      if (!validated.ok) throw new Error('模擬出力が draft スキーマに合いません');
      const result = await client.query<{ completed: boolean }>(
        'select public.complete_ai_job($1, $2, $3::jsonb, null, $4) as completed',
        [jobId, workerName, JSON.stringify(validated.value), 'e2e-fixture'],
      );
      return result.rows[0]?.completed === true;
    },
    close: () => client.end(),
  };
}
