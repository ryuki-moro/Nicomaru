/**
 * ローカル開発専用: Issue「画面のスクリーンショットを揃える」用の撮影スクリプト。
 * 前提: npx supabase start 済み・npm run dev 済み・scripts/bootstrap-demo-planner.mts 実行済み。
 * 実行: npx tsx scripts/screenshot-tour.mts
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium, devices, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

function loadEnvLocal() {
  const text = readFileSync('.env.local', 'utf-8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}
loadEnvLocal();

// Supabase の auth.site_url (supabase/config.toml) が http://127.0.0.1:3000 のため、
// PKCE の code_verifier を保持する localStorage のオリジンをそこに揃える。
// localhost と 127.0.0.1 は別オリジン扱いになり、ずれるとメール認証後の
// exchangeCodeForSession が「別オリジンに保存された検証値」を読めず失敗する。
const BASE = 'http://127.0.0.1:3000';
const OUT_DIR = 'docs/screenshots';

const PLANNER_EMAIL = 'planner@nicomaru.test';
const PLANNER_PASSWORD = 'Passw0rd-Demo!';
const COUPLE_EMAIL = 'yamada.hanako@example.test';

mkdirSync(OUT_DIR, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: true });
  console.log('saved', name);
}

/**
 * 画面の見た目を撮るだけなので、招待メールのUI往復（Mailpit経由）は再現せず、
 * Admin API でワンタイムトークンを発行し、その場で検証してセッションを得る。
 * initial-register の establishSession と同じ考え方（6-6-1）。
 */
async function getCoupleSessionTokens(): Promise<{ access_token: string; refresh_token: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: COUPLE_EMAIL,
  });
  if (linkErr || !linkData.properties?.hashed_token) throw linkErr ?? new Error('no hashed_token');

  const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyErr || !verifyData.session) throw verifyErr ?? new Error('no session');

  return { access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token };
}

async function loginAsPlanner(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: 'パスワードでログイン（プランナー・管理者）' }).click();
  await page.getByLabel('メールアドレス').fill(PLANNER_EMAIL);
  await page.getByLabel('パスワード').fill(PLANNER_PASSWORD);
  await page.getByRole('button', { name: 'パスワードでログイン' }).click();
  await page.waitForURL(/\/dashboard/);
}

async function loginAsCouple(page: Page) {
  const { access_token, refresh_token } = await getCoupleSessionTokens();
  // LoginForm.tsx がハッシュの access_token／refresh_token を拾って setSession する経路を使う（6-3-1）
  await page.goto(`${BASE}/login#access_token=${access_token}&refresh_token=${refresh_token}`);
  await page.waitForURL(/\/mypage/, { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState('networkidle');
}

async function main() {
  const browser = await chromium.launch();

  // ---- デスクトップ: プランナー側 ------------------------------------------------
  const staffDesktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP' });
  const staffPage = await staffDesktop.newPage();

  await staffPage.goto(`${BASE}/login`);
  await shot(staffPage, '01-login');

  await loginAsPlanner(staffPage);
  await shot(staffPage, '02-dashboard');

  await staffPage.goto(`${BASE}/cases`);
  await shot(staffPage, '03-case-list');

  const caseLink = staffPage.locator('a[href^="/cases/"]:not([href="/cases/new"])').first();
  const caseHref = await caseLink.getAttribute('href');
  await caseLink.click();
  await staffPage.waitForLoadState('networkidle');
  await shot(staffPage, '04-case-detail');

  await staffPage.goto(`${BASE}/submissions`);
  await shot(staffPage, '05-submissions-list');

  const submissionLink = staffPage.locator('a[href^="/submissions/"]').first();
  if (await submissionLink.count()) {
    await submissionLink.click();
    await staffPage.waitForLoadState('networkidle');
    await shot(staffPage, '06-submission-review');
  } else {
    console.log('no submitted items to review yet, skipping 06-submission-review');
  }

  if (caseHref) {
    await staffPage.goto(`${BASE}${caseHref}/sheet`);
    await shot(staffPage, '07-prep-sheet');
  }

  await staffDesktop.storageState({ path: `${OUT_DIR}/.staff-state.json` });

  // ---- デスクトップ: 新郎新婦側 ---------------------------------------------------
  const coupleDesktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP' });
  const couplePage = await coupleDesktop.newPage();

  await loginAsCouple(couplePage);
  await shot(couplePage, '08-couple-mypage');

  await couplePage.goto(`${BASE}/mypage/tasks`);
  await shot(couplePage, '09-couple-tasks');

  const pendingTask = couplePage.getByText('引き出物の選択');
  if (await pendingTask.count()) {
    await pendingTask.first().click();
    await couplePage.waitForLoadState('networkidle');
    await shot(couplePage, '10-couple-task-submit');
  }

  await coupleDesktop.storageState({ path: `${OUT_DIR}/.couple-state.json` });

  // ---- モバイル（iPhone 13） -------------------------------------------------------
  const iphone = devices['iPhone 13'];

  const staffMobile = await browser.newContext({ ...iphone, locale: 'ja-JP', storageState: `${OUT_DIR}/.staff-state.json` });
  const staffMobilePage = await staffMobile.newPage();
  await staffMobilePage.goto(`${BASE}/dashboard`);
  await shot(staffMobilePage, '11-mobile-dashboard');
  if (caseHref) {
    await staffMobilePage.goto(`${BASE}${caseHref}`);
    await shot(staffMobilePage, '12-mobile-case-detail');
  }
  await staffMobile.close();

  const coupleMobileNoSession = await browser.newContext({ ...iphone, locale: 'ja-JP' });
  const coupleMobileLoginPage = await coupleMobileNoSession.newPage();
  await coupleMobileLoginPage.goto(`${BASE}/login`);
  await shot(coupleMobileLoginPage, '13-mobile-login');
  await coupleMobileNoSession.close();

  const coupleMobile = await browser.newContext({ ...iphone, locale: 'ja-JP', storageState: `${OUT_DIR}/.couple-state.json` });
  const coupleMobilePage = await coupleMobile.newPage();
  await coupleMobilePage.goto(`${BASE}/mypage`);
  await shot(coupleMobilePage, '14-mobile-mypage');
  await coupleMobilePage.goto(`${BASE}/mypage/tasks`);
  await shot(coupleMobilePage, '15-mobile-tasks');
  await coupleMobile.close();

  await browser.close();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
