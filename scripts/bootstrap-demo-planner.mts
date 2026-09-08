/**
 * ローカル開発専用: スクリーンショット撮影のためのプランナーアカウントを1件作成する。
 * 実行: npx tsx scripts/bootstrap-demo-planner.mts
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を .env.local から読む。
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnvLocal() {
  const text = readFileSync('.env.local', 'utf-8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}
loadEnvLocal();

const VENUE_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'planner@nicomaru.test';
const PASSWORD = 'Passw0rd-Demo!';
const DISPLAY_NAME = '佐藤 花子';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createErr) throw createErr;

  const { error: profileErr } = await admin.from('user_profiles').insert({
    auth_user_id: created.user.id,
    venue_id: VENUE_ID,
    role: 'planner',
    display_name: DISPLAY_NAME,
    email: EMAIL,
    status: 'active',
  });
  if (profileErr) throw profileErr;

  console.log('planner created:', EMAIL, PASSWORD);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
