/**
 * デモ・テスト用の模擬データを入れる（Issue #24）。
 *
 * 使い方（詳しくは docs/環境の使い分け.md）:
 *   npm run demo:seed                 … ローカル Supabase に模擬データを入れる（既にあれば作らない）
 *   npm run demo:reset                … 模擬データの案件を消してから入れ直す（日付が今日基準に揃う）
 *   npm run demo:seed -- --login-links … 登録済みの新郎新婦のログイン用リンクも表示する
 *   npm run demo:seed -- --remote      … 共有デモ環境に入れる（接続先は環境変数で指定）
 *
 * 入れるデータはすべて架空のもの（scripts/demo/scenario.ts）。実在の人の情報は入れない。
 *
 * 必要な環境変数（.env.local にあれば自動で読む。シェルで渡した値が優先）:
 *   NEXT_PUBLIC_SUPABASE_URL   … Auth ユーザーを作る先
 *   SUPABASE_SERVICE_ROLE_KEY  … 同上（Admin API）。このスクリプトはアプリ本体ではないので
 *                                createSupabaseAdminClient の使用範囲表（6-3-5）の対象外
 *   PII_ENCRYPTION_KEY / PII_HMAC_KEY … アプリと同じ鍵（違うと画面で氏名が読めない）
 *   DEMO_DATABASE_URL          … 省略時はローカル Supabase（postgres://postgres:postgres@127.0.0.1:54322/postgres）
 *   APP_BASE_URL               … 招待URLの組み立てに使う（省略時 http://127.0.0.1:3000）
 *   DEMO_PLANNER_PASSWORD      … 共有デモ環境では必須。ローカルは省略時に固定値を使う
 *   INTERNAL_CRON_SECRET       … あればリスクの再計算まで行う（アプリが起動している必要あり）
 */
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Client } from 'pg';

import { todayInJst } from '../src/lib/format';
import { pgDemoDb } from './demo/pgDb';
import { DEMO_CASES, DEMO_PLANNER } from './demo/scenario';
import { resetDemo, seedDemo, type DemoAuth } from './demo/seed';
import { assertDemoAppTarget, assertDemoProjectTargets } from './demo/targets';

// ------------------------------------------------------------------ 設定の読み込み

function loadEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync('.env.local', 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const matched = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(raw.replace('\r', ''));
    if (!matched) continue;
    const value = matched[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[matched[1]] === undefined) process.env[matched[1]] = value;
  }
}

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) die(`${name} が設定されていません（.env.local を確認してください）`);
  return value;
}

loadEnvLocal();

const args = new Set(process.argv.slice(2));
const wantsReset = args.has('--reset');
const wantsLoginLinks = args.has('--login-links');
const remote = args.has('--remote');

/** ローカルの既定値。`npx supabase start` の固定値で、外部からは使えない */
const LOCAL_DB_URL = 'postgres://postgres:postgres@127.0.0.1:54322/postgres';
const LOCAL_PLANNER_PASSWORD = 'Passw0rd-Demo!';

const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
required('PII_ENCRYPTION_KEY');
required('PII_HMAC_KEY');
const databaseUrl = process.env.DEMO_DATABASE_URL || LOCAL_DB_URL;
const appBaseUrl = process.env.APP_BASE_URL || 'http://127.0.0.1:3000';

// ------------------------------------------------------------------ 接続先の確認

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

const targets = [
  { name: 'Supabase', url: supabaseUrl },
  { name: 'データベース', url: databaseUrl },
];
try {
  assertDemoProjectTargets(supabaseUrl, databaseUrl);
  assertDemoAppTarget(appBaseUrl, remote);
} catch (error) {
  die((error as Error).message);
}
const nonLocal = targets.filter((t) => !isLocalHost(t.url));

if (nonLocal.length > 0 && !remote) {
  die(
    `接続先がローカルではありません: ${nonLocal.map((t) => `${t.name}=${new URL(t.url).hostname}`).join(', ')}\n` +
      '  共有デモ環境に入れるときは --remote を付けてください（docs/環境の使い分け.md）。',
  );
}
if (remote && nonLocal.length !== targets.length) {
  // Auth と DB が別の環境を指していると、作ったユーザーが DB に無い状態になる
  die(
    '--remote のときは NEXT_PUBLIC_SUPABASE_URL と DEMO_DATABASE_URL の両方を共有デモ環境に向けてください。',
  );
}

const plannerPassword =
  process.env.DEMO_PLANNER_PASSWORD ||
  (remote
    ? die('共有デモ環境では DEMO_PLANNER_PASSWORD を指定してください（リポジトリに書かない）')
    : LOCAL_PLANNER_PASSWORD);
if (plannerPassword.length < 12)
  die('DEMO_PLANNER_PASSWORD は12文字以上にしてください（プランナーのパスワード規約）');

console.log(`\n  接続先: ${remote ? '共有デモ環境' : 'ローカル'}（${new URL(supabaseUrl).host}）`);

// ------------------------------------------------------------------ Auth ユーザー

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUserId(client: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

const demoAuth: DemoAuth = {
  async ensureUser(email, { displayName, password }) {
    const existing = await findUserId(admin, email);
    if (existing) {
      // パスワードを指定したとき（プランナー）は、毎回その値に揃える
      if (password) {
        const { error } = await admin.auth.admin.updateUserById(existing, { password });
        if (error) throw error;
      }
      return existing;
    }
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (error || !data.user) throw error ?? new Error(`Auth ユーザーを作れませんでした: ${email}`);
    return data.user.id;
  },
};

// ------------------------------------------------------------------ 実行

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
} catch (error) {
  die(
    `データベースに接続できません: ${(error as Error).message}\n` +
      (remote
        ? '  DEMO_DATABASE_URL を確認してください。'
        : '  `npx supabase start` を実行してから、もう一度試してください。'),
  );
}

const db = pgDemoDb(client);

// URL照合に加えて、既存プランナーがいればUUIDも読取だけで照合する。
// 初回の空Authでも、この確認のためにユーザーを作成したりpasswordを変えたりしない。
try {
  const existingPlannerId = await findUserId(admin, DEMO_PLANNER.email);
  if (existingPlannerId) {
    const sameProject = await client.query('select 1 from auth.users where id = $1', [
      existingPlannerId,
    ]);
    if (sameProject.rows.length === 0) {
      throw new Error('Auth と DB の既存利用者が一致しません。同じプロジェクトに揃えてください');
    }
  }
} catch (error) {
  await client.end();
  die(`接続先を確認できませんでした（Auth は変更していません）: ${(error as Error).message}`);
}

let result;
try {
  // DB 側は1トランザクション。途中で失敗したら、半端な案件を残さず全部戻す
  await client.query('begin');
  if (wantsReset) {
    const removed = await resetDemo(db);
    console.log(`  模擬データの案件を ${removed} 件消しました`);
  }
  result = await seedDemo(db, demoAuth, { plannerPassword, today: todayInJst(), appBaseUrl });
  await client.query('commit');
} catch (error) {
  await client.query('rollback').catch(() => {});
  await client.end();
  die(
    `模擬データを入れられませんでした（案件などのDB変更はロールバックしました。` +
      `Auth のユーザー作成・パスワード変更は残る場合があります）: ${(error as Error).message}`,
  );
}
await client.end();

// ------------------------------------------------------------------ リスクの再計算

async function recalculateRisk(): Promise<string> {
  const secret = process.env.INTERNAL_CRON_SECRET;
  if (!secret) return 'INTERNAL_CRON_SECRET が無いので省略しました';
  try {
    const res = await fetch(`${appBaseUrl.replace(/\/+$/, '')}/api/internal/risk-recalculate`, {
      method: 'POST',
      headers: { 'x-internal-cron-secret': secret },
    });
    if (!res.ok) return `失敗しました（HTTP ${res.status}）`;
    const body = (await res.json()) as { processed?: number };
    return `${body.processed ?? 0} 件を再計算しました`;
  } catch {
    return `アプリ（${appBaseUrl}）に接続できないので省略しました`;
  }
}

const riskMessage =
  result.created.length > 0 ? await recalculateRisk() : '新しい案件が無いので省略しました';

// ------------------------------------------------------------------ 結果の表示

console.log('');
console.log('  ── プランナー ────────────────────────────────');
console.log(`    メール     : ${result.plannerEmail}`);
console.log(`    パスワード : ${remote ? '（DEMO_PLANNER_PASSWORD の値）' : plannerPassword}`);
console.log(`    ログイン   : ${appBaseUrl}/login →「パスワードでログイン」`);

if (result.created.length > 0) {
  console.log('');
  console.log('  ── 作った案件 ────────────────────────────────');
  for (const c of result.created) {
    console.log(`    ${c.caseCode}  挙式 ${c.weddingDate}  ${c.purpose}`);
    for (const email of c.registeredEmails) console.log(`      登録済み : ${email}`);
    for (const invite of c.pendingInviteUrls) {
      console.log(`      未登録   : ${invite.name}（${invite.partnerRole}）の招待URL`);
      console.log(`                 ${invite.url}`);
    }
  }
}
if (result.skipped.length > 0) {
  console.log('');
  console.log(`  既にあったので作らなかった案件: ${result.skipped.join(', ')}`);
  console.log('  日付を今日基準に揃え直すときは `npm run demo:reset`。');
}

console.log('');
console.log(`  リスクの再計算: ${riskMessage}`);

if (wantsLoginLinks) {
  console.log('');
  console.log('  ── 新郎新婦のログイン用リンク（1回きり・1時間で失効） ──');
  const emails = DEMO_CASES.flatMap((c) => [c.groom, c.bride])
    .filter((p) => p.registered)
    .map((p) => p.email);
  for (const email of emails) {
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: `${appBaseUrl.replace(/\/+$/, '')}/login` },
    });
    console.log(`    ${email}`);
    console.log(
      `      ${error ? `発行できませんでした: ${error.message}` : data.properties.action_link}`,
    );
  }
} else if (!remote) {
  console.log('  新郎新婦としてログインするときは、ログイン画面でメールアドレスを入れ、');
  console.log('  ローカルの受信箱（Mailpit http://127.0.0.1:54324）に届くワンタイムコードを使う。');
}
console.log('');
