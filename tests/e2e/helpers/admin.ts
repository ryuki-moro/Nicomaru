/**
 * テストデータの投入（Supabase Admin API／service_role）。
 * アプリ本体は触らず、seed.sql が作らない「人」だけをここで用意する。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { e2eEnv, PLANNER_PASSWORD, uniqueEmail, VENUE_ID } from './env';

export interface PlannerAccount {
  email: string;
  password: string;
  displayName: string;
}

let cached: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (!cached) {
    cached = createClient(e2eEnv.supabaseUrl, e2eEnv.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cached;
}

/**
 * プランナーを1人作る。Auth ユーザー＋user_profiles（seed の式場に所属）。
 * bootstrap-system-admin と同じく、Auth 側は Admin API でしか作れない。
 */
export async function createPlanner(displayName = 'E2E プランナー'): Promise<PlannerAccount> {
  const admin = adminClient();
  const email = uniqueEmail('planner');

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: PLANNER_PASSWORD,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`プランナーの Auth ユーザー作成に失敗: ${createError?.message ?? 'unknown'}`);
  }

  const { error: profileError } = await admin.from('user_profiles').insert({
    auth_user_id: created.user.id,
    venue_id: VENUE_ID,
    role: 'planner',
    display_name: displayName,
    email,
    status: 'active',
  });
  if (profileError) {
    // 片方だけ残るとそのメールで二度と作れなくなるので Auth 側も消す
    await admin.auth.admin.deleteUser(created.user.id);
    throw new Error(`user_profiles の作成に失敗: ${profileError.message}`);
  }

  return { email, password: PLANNER_PASSWORD, displayName };
}

const E2E_WORKER = 'e2e-worker';

/**
 * AIワーカーの心拍を書く（7-1／7-3(4)）。`ai_assist_status()` は
 * 「最新の last_seen_at が10分以内」なら利用可と判定する。
 */
export async function setAiWorkerHeartbeat(minutesAgo: number): Promise<void> {
  const lastSeenAt = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  const { error } = await adminClient()
    .from('ai_worker_heartbeats')
    .upsert({ worker_name: E2E_WORKER, model_name: 'e2e-model', last_seen_at: lastSeenAt });
  if (error) throw new Error(`ai_worker_heartbeats の書き込みに失敗: ${error.message}`);
}

/** 心拍を全て消す＝「利用不可」の状態にする */
export async function clearAiWorkerHeartbeats(): Promise<void> {
  const { error } = await adminClient().from('ai_worker_heartbeats').delete().neq('worker_name', '');
  if (error) throw new Error(`ai_worker_heartbeats の削除に失敗: ${error.message}`);
}
