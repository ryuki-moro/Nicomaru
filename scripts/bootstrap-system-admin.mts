/**
 * system_admin の初期アカウントを作る（12章「初期データ・セットアップ設計」(b)）。
 *
 * 正本: 基本設計書 12章／6-3-1／表4-19。
 *
 *   「(b) system_admin 初期アカウントの作成手順と実施者を定める」
 *   「seed マイグレーションは auth.users を作らない」
 *
 * seed.sql は式場・プラン種別・宿題テンプレート・リスクルールまでを投入するが、
 * **Auth ユーザーだけは作れない**。auth スキーマは Supabase の管理下にあり、
 * SQL から直接 insert すると Auth 側の内部状態と食い違うため。
 * そこで Auth Admin API を使うこのスクリプトに分けている。
 *
 * 【パスワードをここで決めない理由】
 * このスクリプトはパスワードを一切扱わない。
 * Auth ユーザーを作ったうえで「初回パスワード設定リンク」を発行し、
 * 本人が自分で決める（6-3-1）。U02 の利用者登録と同じ流れにしてある。
 * 誰かが決めたパスワードを口頭やチャットで渡す運用にしないための作り。
 *
 * 使い方:
 *   npm run bootstrap:admin -- --email you@example.com --name 山田太郎
 *
 * 必要な環境変数（.env.local に入っていれば自動で読まれる）:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   APP_BASE_URL           … 設定リンクの戻り先
 *   RESEND_API_KEY         … 未設定ならメールは送らず、リンクを画面に出す
 */
import { readFileSync } from 'node:fs';

import { issuePasswordSetupLink, sendPasswordSetupMail } from '../src/lib/notify/mailer';
import { createSupabaseAdminClient } from '../src/lib/supabase/admin';

/**
 * .env.local を読む。
 *
 * Next.js が使う @next/env は CJS のため ESM から名前付きで読み込めない。
 * ここで要るのは KEY=VALUE を環境変数へ移すだけなので自前で読む。
 * すでに環境変数がある場合は上書きしない（シェルで渡した値を優先する）。
 */
function loadEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync('.env.local', 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace('\r', '');
    const matched = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!matched) continue;
    const value = matched[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[matched[1]] === undefined) process.env[matched[1]] = value;
  }
}

loadEnvLocal();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const email = arg('email')?.trim().toLowerCase();
const displayName = arg('name')?.trim();

if (!email || !displayName) {
  die('使い方: npm run bootstrap:admin -- --email you@example.com --name 山田太郎');
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  die(`メールアドレスの形式が正しくありません: ${email}`);
}

const admin = createSupabaseAdminClient('setup.bootstrap-system-admin');

// ------------------------------------------------------------------ 二重作成の防止
// system_admin は式場に属さない全体管理者で、何人も要らない。
// 実行を繰り返して増やしてしまわないよう、既にいる場合は止める。
const existing = await admin
  .from('user_profiles')
  .select('id, email, status')
  .eq('role', 'system_admin');

if (existing.error) {
  die(`利用者を確認できませんでした: ${existing.error.message}`);
}

const rows = (existing.data ?? []) as { id: string; email: string; status: string }[];
if (rows.length > 0) {
  const list = rows.map((row) => `    - ${row.email}（${row.status}）`).join('\n');
  die(
    `system_admin はすでに存在します。\n${list}\n\n`
    + '  追加したい場合は、既存の system_admin でログインして S01 から登録してください。\n'
    + '  作り直したい場合は、先に既存のアカウントを停止（suspended）してください。',
  );
}

// ------------------------------------------------ Auth ユーザーの作成と設定リンクの発行
// generateLink({ type: 'invite' }) は Auth ユーザーの作成も同時に行う（6-3-1）。
console.log(`\n  Auth ユーザーを作成しています: ${email}`);
const issued = await issuePasswordSetupLink(admin, { email });

if (!issued.ok) {
  if (issued.reason === 'already_registered') {
    die(
      `このメールアドレスの Auth ユーザーは既に存在します: ${email}\n\n`
      + '  利用者プロフィールだけが無い状態の可能性があります。\n'
      + '  Supabase の Authentication 画面で該当ユーザーを削除してから、'
      + 'もう一度実行してください。',
    );
  }
  die(`設定リンクを発行できませんでした: ${issued.detail ?? '原因不明'}`);
}

// ------------------------------------------------------------------ プロフィールの作成
// venue_id は NULL。system_admin は特定の式場に属さない（表4-19）。
// status='active' で作る。招待経由ではないので invited を経由しない。
const created = await admin
  .from('user_profiles')
  .insert({
    auth_user_id: issued.authUserId,
    venue_id: null,
    role: 'system_admin',
    display_name: displayName,
    email,
    status: 'active',
  })
  .select('id')
  .single();

if (created.error) {
  // プロフィールが無いまま Auth ユーザーだけ残ると、そのメールでは二度と登録できなくなる。
  // /api/admin/users と同じ後始末をする。
  await admin.auth.admin.deleteUser(issued.authUserId);
  die(`利用者プロフィールを作成できませんでした: ${created.error.message}`);
}

// ------------------------------------------------------------------ 案内メール
const sent = await sendPasswordSetupMail({
  to: email,
  displayName,
  roleLabel: 'システム管理者',
  actionLink: issued.actionLink,
});

console.log('\n  完了しました。');
console.log(`    利用者ID : ${(created.data as { id: string }).id}`);
console.log(`    メール   : ${email}`);
console.log('    権限     : system_admin（式場に属さない全体管理者）');

if (sent.delivered) {
  console.log('\n  パスワード設定のご案内メールを送信しました。');
  console.log('  受信箱を確認して、リンクからパスワードを設定してください。');
} else {
  // メール未設定（#17 が未完了）でも作業を止めない。リンクを直接渡す。
  console.log('\n  メールは送信していません（送信設定が未完了のため）。');
  console.log('  下のリンクを自分で開いて、パスワードを設定してください。');
  console.log(`\n  ${issued.actionLink}`);
  console.log('\n  このリンクは一度きり・期限つきです。他人に共有しないでください。');
}

console.log('');
