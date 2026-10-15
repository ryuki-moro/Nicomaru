/**
 * 画面のスクリーンショットを撮り直す（Issue #28）。
 *
 * 前提:
 *   - npx supabase start 済み（Mailpit が 127.0.0.1:54324 で動いている）
 *   - npm run dev 済み（APP_BASE_URL の値で開ける）
 *   - npm run demo:reset -- --login-links 済み（模擬データ・プランナーのパスワードを揃える）
 * 実行: npm run screenshots
 *
 * 新郎新婦はメールアドレスを入力し、Mailpit に届いた6桁のコードでログインする（UI と同じ経路）。
 * 撮影のたびに同じ画面を撮り直せるよう、ログインリンクやトークンは使わず、ファイルにも残さない。
 *
 * PC 版（1440px）は長い画面を全体（fullPage）で撮る。スマホ版（iPhone 13 = 390px 幅）は
 * 1画面ぶん（viewport）で撮る。新郎新婦側の下部ナビは固定配置のため、全体撮影では途中に写り込む。
 * そこで PC の全体撮影では下部ナビを隠し、スマホの1画面撮影では本来の見た目のまま残す。
 * Next.js の開発用バッジ（左下の N）は、どの撮影でも隠す。
 */
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { chromium, devices, type BrowserContext, type Locator, type Page } from '@playwright/test';

// .env.local の APP_BASE_URL をそのまま使う（送信元検証は APP_BASE_URL と一致する必要がある）。
// プロセスに既に値があれば上書きしない（playwright.config.ts と同じ扱い）。
function loadEnvLocal() {
  try {
    for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] ??= m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch {
    // .env.local が無ければ既定値で動かす
  }
}
loadEnvLocal();

const BASE = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';
const OUT_DIR = 'docs/screenshots';

// demo:reset の模擬データ（scripts/demo/scenario.ts）。案件は「不備ありの差し戻し」と「確認待ち」が両方ある demo-02 を使う。
const PLANNER_EMAIL = 'planner@nicomaru.test';
const PLANNER_PASSWORD = 'Passw0rd-Demo!';
const COUPLE_EMAIL = 'demo-02-groom@demo.nicomaru.test';
const DEMO_CASE_CODE = 'BRIDAL01-2026-0003';

const PC = { viewport: { width: 1440, height: 900 } };
const SP = { ...devices['iPhone 13'] };
const COMMON = { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };

mkdirSync(OUT_DIR, { recursive: true });

// ---- Mailpit から6桁コードを取る ---------------------------------------------

interface MailpitList {
  messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
}
interface MailpitMessage {
  HTML: string;
  Text: string;
}

async function mailIds(): Promise<Set<string>> {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=200`);
  const json = (await res.json()) as MailpitList;
  return new Set(json.messages.map((m) => m.ID));
}

/** 送信前に届いていたメールを除き、宛先の新しいメールから6桁コードを取り出す。 */
async function waitForOtp(email: string, seenBefore: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
    const { messages } = (await res.json()) as MailpitList;
    const fresh = messages.find(
      (m) => !seenBefore.has(m.ID) && m.To.some((to) => to.Address === email),
    );
    if (fresh) {
      const detail = (await (
        await fetch(`${MAILPIT}/api/v1/message/${fresh.ID}`)
      ).json()) as MailpitMessage;
      const body = detail.HTML || detail.Text;
      // メール本文の <strong> に入るコードを優先する（リンクの token と取り違えない）
      const code = body.match(/<strong>\s*(\d{6})\s*<\/strong>/) ?? body.match(/\b(\d{6})\b/);
      if (code) return code[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${email} 宛のワンタイムコードが Mailpit に届きませんでした`);
}

// ---- ログイン -----------------------------------------------------------------

async function loginAsPlanner(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: 'パスワードでログイン（プランナー・管理者）' }).click();
  await page.getByLabel('メールアドレス').fill(PLANNER_EMAIL);
  await page.getByLabel('パスワード', { exact: true }).fill(PLANNER_PASSWORD);
  await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

async function loginAsCouple(page: Page) {
  await page.goto(`${BASE}/login`);
  const seenBefore = await mailIds();
  await page.getByLabel('メールアドレス').fill(COUPLE_EMAIL);
  await page.getByRole('button', { name: 'ログインリンクを送信', exact: true }).click();
  const code = await waitForOtp(COUPLE_EMAIL, seenBefore);
  // OtpInput は1マスずつ入力する。6桁そろうと自動で認証に進む
  for (const [index, digit] of [...code].entries()) {
    await page.getByLabel(`ワンタイムコード ${index + 1}桁目`).fill(digit);
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
}

// ---- 撮影 -----------------------------------------------------------------------

/**
 * 開発用バッジ（nextjs-portal）は常に隠す。
 * PC の全体撮影では新郎新婦の下部ナビ（固定配置）も隠す。スマホの1画面撮影では残す。
 */
async function prepare(page: Page, hideBottomNav: boolean) {
  await page.evaluate((hideNav) => {
    document.getElementById('shot-style')?.remove();
    const style = document.createElement('style');
    style.id = 'shot-style';
    style.textContent =
      'nextjs-portal{display:none!important}' +
      (hideNav ? '.fixed.inset-x-0.bottom-0{display:none!important}' : '');
    document.head.appendChild(style);
  }, hideBottomNav);
}

async function shot(page: Page, name: string, opts: { device: 'pc' | 'sp'; scrollTo?: Locator }) {
  await page.waitForLoadState('networkidle').catch(() => {});
  const fullPage = opts.device === 'pc';
  await prepare(page, fullPage);
  if (opts.scrollTo) await opts.scrollTo.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage });
  console.log('saved', name);
}

/** 一覧から、指定の文字列を含むリンクの href を取る。無ければ止める（別の模擬データを撮ってしまわないため） */
async function hrefFor(page: Page, prefix: string, text: string): Promise<string> {
  const link = page.locator(`a[href^="${prefix}"]`).filter({ hasText: text }).first();
  const href = await link.getAttribute('href', { timeout: 10_000 }).catch(() => null);
  if (!href) throw new Error(`${prefix} のうち「${text}」を含むリンクが見つかりませんでした`);
  return href;
}

async function main() {
  const browser = await chromium.launch();
  try {
    // ================= プランナー（PC） =================
    const staffPc = await browser.newContext({ ...PC, ...COMMON });
    const staffPcPage = await staffPc.newPage();

    await staffPcPage.goto(`${BASE}/login`);
    await shot(staffPcPage, '01-login', { device: 'pc' });

    await loginAsPlanner(staffPcPage);
    await shot(staffPcPage, '02-planner-dashboard', { device: 'pc' });

    await staffPcPage.goto(`${BASE}/cases`);
    await shot(staffPcPage, '03-case-list', { device: 'pc' });

    const caseHref = await hrefFor(staffPcPage, '/cases/', DEMO_CASE_CODE);
    await staffPcPage.goto(`${BASE}${caseHref}`);
    await shot(staffPcPage, '04-case-detail', { device: 'pc' });

    await staffPcPage.goto(`${BASE}/submissions`);
    await shot(staffPcPage, '05-submissions-list', { device: 'pc' });

    const reviewHref = await hrefFor(staffPcPage, '/submissions/', DEMO_CASE_CODE);
    await staffPcPage.goto(`${BASE}${reviewHref}`);
    await shot(staffPcPage, '06-submission-review', { device: 'pc' });

    await staffPcPage.goto(`${BASE}${caseHref}/sheet`);
    await shot(staffPcPage, '07-prep-sheet', { device: 'pc' });

    const staffState = await staffPc.storageState();

    // ================= 新郎新婦（PC） =================
    const couplePc = await browser.newContext({ ...PC, ...COMMON });
    const couplePcPage = await couplePc.newPage();

    await loginAsCouple(couplePcPage);
    await couplePcPage.goto(`${BASE}/mypage`);
    await shot(couplePcPage, '08-couple-mypage', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/tasks`);
    await shot(couplePcPage, '09-couple-tasks', { device: 'pc' });

    // 提出画面は形式ごとに撮る（select・text・file）
    const selectHref = await hrefFor(couplePcPage, '/mypage/tasks/', '引き出物の選択');
    await couplePcPage.goto(`${BASE}${selectHref}`);
    await shot(couplePcPage, '10-couple-task-submit', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/tasks`);
    const textHref = await hrefFor(couplePcPage, '/mypage/tasks/', 'BGMリクエスト');
    await couplePcPage.goto(`${BASE}${textHref}`);
    await shot(couplePcPage, '16-couple-task-submit-text', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/tasks`);
    const fileHref = await hrefFor(couplePcPage, '/mypage/tasks/', 'ゲストリスト提出');
    await couplePcPage.goto(`${BASE}${fileHref}`);
    await shot(couplePcPage, '17-couple-task-submit-file', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/timeline`);
    await shot(couplePcPage, '18-couple-timeline', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/case`);
    await shot(couplePcPage, '19-couple-case-info', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/account`);
    await shot(couplePcPage, '20-couple-account', { device: 'pc' });

    const coupleState = await couplePc.storageState();

    // ================= スマホ（iPhone 13・390px）=================
    // ログイン画面だけは未ログインの状態で撮る
    const loginSp = await browser.newContext({ ...SP, ...COMMON });
    const loginSpPage = await loginSp.newPage();
    await loginSpPage.goto(`${BASE}/login`);
    await shot(loginSpPage, '11-mobile-login', { device: 'sp' });
    await loginSp.close();

    const staffSp = await browser.newContext({ ...SP, ...COMMON, storageState: staffState });
    const staffSpPage = await staffSp.newPage();

    await staffSpPage.goto(`${BASE}/dashboard`);
    await shot(staffSpPage, '14-mobile-planner-dashboard', { device: 'sp' });

    await staffSpPage.goto(`${BASE}${caseHref}`);
    await shot(staffSpPage, '15-mobile-case-detail', { device: 'sp' });

    await staffSpPage.goto(`${BASE}/cases`);
    await shot(staffSpPage, '21-mobile-case-list', { device: 'sp' });

    await staffSpPage.goto(`${BASE}/submissions`);
    await shot(staffSpPage, '22-mobile-submissions-list', { device: 'sp' });

    await staffSpPage.goto(`${BASE}${reviewHref}`);
    await shot(staffSpPage, '23-mobile-submission-review', {
      device: 'sp',
      scrollTo: staffSpPage.getByText('AIによる下書き（要確認）'),
    });

    await staffSpPage.goto(`${BASE}${caseHref}/sheet`);
    await shot(staffSpPage, '24-mobile-prep-sheet', { device: 'sp' });
    await staffSp.close();

    const coupleSp = await browser.newContext({ ...SP, ...COMMON, storageState: coupleState });
    const coupleSpPage = await coupleSp.newPage();

    await coupleSpPage.goto(`${BASE}/mypage`);
    await shot(coupleSpPage, '12-mobile-couple-mypage', { device: 'sp' });

    await coupleSpPage.goto(`${BASE}/mypage/tasks`);
    await shot(coupleSpPage, '13-mobile-couple-tasks', { device: 'sp' });

    await coupleSpPage.goto(`${BASE}${selectHref}`);
    await shot(coupleSpPage, '25-mobile-couple-task-submit-select', { device: 'sp' });

    await coupleSpPage.goto(`${BASE}${textHref}`);
    await shot(coupleSpPage, '26-mobile-couple-task-submit-text', { device: 'sp' });

    await coupleSpPage.goto(`${BASE}${fileHref}`);
    await shot(coupleSpPage, '27-mobile-couple-task-submit-file', { device: 'sp' });

    await coupleSpPage.goto(`${BASE}/mypage/timeline`);
    await shot(coupleSpPage, '28-mobile-couple-timeline', { device: 'sp' });

    await coupleSpPage.goto(`${BASE}/mypage/case`);
    await shot(coupleSpPage, '29-mobile-couple-case-info', { device: 'sp' });

    await coupleSpPage.goto(`${BASE}/mypage/account`);
    await shot(coupleSpPage, '30-mobile-couple-account', { device: 'sp' });
    await coupleSp.close();

    await staffPc.close();
    await couplePc.close();
    console.log('done');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
