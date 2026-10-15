/** 開発専用adminを準備し、loopback限定のNext.jsを起動する。 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { createSupabaseAdminClient } from '../src/lib/supabase/admin';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) process.env[match[1]] ??= match[2].trim().replace(/^["']|["']$/g, '');
  }
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('dev:admin は本番環境では起動できません');
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1] ?? '';
}

const port = Number(argument('port', '3000'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ポート番号が正しくありません');
const venueId = argument('venue-id', '11111111-1111-4111-8111-111111111111');
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL を .env.local に設定してください');

const accountFile = resolve('.env.dev-admin.json');
const admin = createSupabaseAdminClient('setup.development-admin');
interface DevAccount {
  supabaseUrl: string;
  venueId: string;
  email: string;
  password: string;
  authUserId: string;
  profileId: string;
}

async function prepareAccount(): Promise<DevAccount> {
  if (existsSync(accountFile)) {
    const account: DevAccount = JSON.parse(readFileSync(accountFile, 'utf8'));
    if (account.supabaseUrl !== supabaseUrl || account.venueId !== venueId
      || !account.email || !account.password || !account.authUserId || !account.profileId) {
      throw new Error('.env.dev-admin.json が現在の開発環境と一致しません。README の管理者モードを確認してください');
    }
    const profile = await admin.from('user_profiles').select('id, role, status, venue_id, email')
      .eq('auth_user_id', account.authUserId).maybeSingle();
    if (profile.error || !profile.data || profile.data.id !== account.profileId
      || profile.data.email !== account.email || profile.data.role !== 'admin'
      || profile.data.status !== 'active' || profile.data.venue_id !== venueId) {
      throw new Error('開発用adminが利用できない状態です。既存アカウントの権限やパスワードは変更していません');
    }
    return account;
  }

  const venue = await admin.from('venues').select('id').eq('id', venueId).eq('active', true).maybeSingle();
  if (venue.error || !venue.data) throw new Error('開発用の式場がありません。seed.sql を適用するか --venue-id を指定してください');

  const email = `dev-admin-${randomBytes(6).toString('hex')}@nicomaru.test`;
  const password = `Nico!${randomBytes(24).toString('base64url')}7a`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error('開発用adminのAuthユーザーを作成できませんでした');
  const authUserId = created.data.user.id;

  try {
    const profile = await admin.from('user_profiles').insert({
      auth_user_id: authUserId,
      venue_id: venueId,
      role: 'admin',
      display_name: '開発用admin',
      email,
      status: 'active',
    }).select('id').single();
    if (profile.error || !profile.data) throw new Error('開発用adminのプロフィールを作成できませんでした');
    const account: DevAccount = {
      supabaseUrl: supabaseUrl!, venueId, email, password, authUserId, profileId: profile.data.id,
    };
    writeFileSync(accountFile, `${JSON.stringify(account, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return account;
  } catch (error) {
    // 作成途中で失敗した場合は、この起動で作ったAuthユーザーだけを取り消す。
    const cleanup = await admin.auth.admin.deleteUser(authUserId);
    if (cleanup.error) console.error('開発用adminの作成を取り消せませんでした。SupabaseのAuthenticationで確認してください');
    throw error;
  }
}

const account = await prepareAccount();
// 更新APIの同一Origin検証とログイン画面への転送は APP_BASE_URL を基準にする。
// .env.local の値（例: localhost:3000）のままだと 127.0.0.1 の別ポートでは全更新APIが403になる。
const appBaseUrl = `http://127.0.0.1:${port}`;
console.log(`開発用adminモード: ${appBaseUrl}/login`);
console.log('「開発用adminで入る」を押すと式場管理者として操作できます。終了は Ctrl+C。');

const child = spawn(process.execPath, [
  resolve('node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port),
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    APP_BASE_URL: appBaseUrl,
    DEV_ADMIN_LOGIN_ENABLED: 'true',
    DEV_ADMIN_EMAIL: account.email,
    DEV_ADMIN_PASSWORD: account.password,
    DEV_ADMIN_AUTH_USER_ID: account.authUserId,
  },
});
child.on('error', () => {
  console.error('開発サーバーを起動できませんでした');
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
