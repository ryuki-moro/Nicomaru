/**
 * 画面のスクリーンショットを撮り直す（Issue #28・#210）。
 *
 * 前提: 別のターミナルで `npm run demo -- --reset` を起動しておく（http://127.0.0.1:3105）。
 * 実行: npm run screenshots
 *
 * ログインはデモのログイン画面と同じ操作で行う（入力は空欄のまま）。
 *   - 「確認コードを送信」… 新郎新婦（demo-02 の新郎）としてログイン
 *   - 「パスワードでログイン」… プランナーとしてログイン
 * パスワードやコードはスクリプトにもファイルにも持たない。
 *
 * PC 版（1440px）は長い画面を全体（fullPage）で撮る。スマホ版（iPhone 13 = 390px 幅）は
 * 1画面ぶん（viewport）で撮る。新郎新婦側の下部ナビは固定配置のため、全体撮影では途中に写り込む。
 * そこで PC の全体撮影では下部ナビを隠し、スマホの1画面撮影では本来の見た目のまま残す。
 * Next.js の開発用バッジ（左下の N）は、どの撮影でも隠す。
 *
 * 新しい画面を足すときは、既存の番号（01〜32）を変えず、33 以降に続ける。
 * プランナーの「席次の確認」は、新郎新婦が席次を提出してから中身が出る。デモの案件には
 * 出席のゲストがまだいないため提出できず、撮っていない（撮るときは 33 番にする）。
 */
import { mkdirSync } from 'node:fs';
import { chromium, devices, type Locator, type Page } from '@playwright/test';

const BASE = process.env.SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:3105';
const OUT_DIR = 'docs/screenshots';

// デモの模擬データ（scripts/d1-demo-fixtures.mjs）。新郎新婦は demo-02（石井さま）の案件に入る。
const DEMO_CASE_CODE = 'BRIDAL01-2027-0001';

const PC = { viewport: { width: 1440, height: 900 } };
const SP = { ...devices['iPhone 13'] };
const COMMON = { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };

mkdirSync(OUT_DIR, { recursive: true });

// ---- ログイン -----------------------------------------------------------------

/** デモのログインは API の応答後に画面を移る。移らなかったときは着地点を直接開く。 */
async function landOn(page: Page, path: RegExp, fallback: string) {
  await page.waitForURL(path, { timeout: 20_000 }).catch(async () => {
    await page.goto(`${BASE}${fallback}`);
  });
  if (!path.test(new URL(page.url()).pathname)) {
    throw new Error(`ログイン後に ${fallback} を開けませんでした（${page.url()}）`);
  }
}

async function loginAsPlanner(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: 'パスワードでログイン（プランナー・管理者）' }).click();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/auth/demo-login'));
  await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
  if (!(await response).ok()) throw new Error('プランナーとしてログインできませんでした');
  await landOn(page, /^\/(cases|dashboard)/, '/dashboard');
}

async function loginAsCouple(page: Page) {
  await page.goto(`${BASE}/login`);
  const response = page.waitForResponse((r) => r.url().endsWith('/api/auth/demo-login'));
  await page.getByRole('button', { name: '確認コードを送信', exact: true }).click();
  if (!(await response).ok()) throw new Error('新郎新婦としてログインできませんでした');
  await landOn(page, /^\/mypage/, '/mypage');
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

async function shot(
  page: Page,
  name: string,
  opts: { device: 'pc' | 'sp'; scrollTo?: Locator; element?: Locator },
) {
  await page.waitForLoadState('networkidle').catch(() => {});
  const fullPage = opts.device === 'pc';
  await prepare(page, fullPage);
  if (opts.scrollTo) await opts.scrollTo.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const path = `${OUT_DIR}/${name}.png`;
  if (opts.element) await opts.element.first().screenshot({ path });
  else await page.screenshot({ path, fullPage });
  console.log('saved', name);
}

/** 一覧から、指定の文字列を含むリンクの href を取る。無ければ止める（別の模擬データを撮ってしまわないため） */
async function hrefFor(page: Page, prefix: string, text: string): Promise<string> {
  const link = page.locator(`a[href^="${prefix}"]`).filter({ hasText: text }).first();
  const href = await link.getAttribute('href', { timeout: 10_000 }).catch(() => null);
  if (!href) throw new Error(`${prefix} のうち「${text}」を含むリンクが見つかりませんでした`);
  return href;
}

/** 表の中で、指定の文字列をすべて含む行から、prefix で始まるリンクを取る。 */
async function rowHrefFor(page: Page, prefix: string, texts: string[]): Promise<string> {
  let row = page.locator('tbody tr');
  for (const text of texts) row = row.filter({ hasText: text });
  const href = await row
    .first()
    .locator(`a[href^="${prefix}"]`)
    .first()
    .getAttribute('href', { timeout: 10_000 })
    .catch(() => null);
  if (!href) throw new Error(`表に「${texts.join('・')}」の行が見つかりませんでした`);
  return href;
}

/**
 * 席次の画面に写すものが無いと空の案内だけになるので、配置パターンが1つも無ければ
 * プランナーの画面操作で1つ作り（既定のひな形のまま）、新郎新婦に送る。
 * デモのデータを変えるので、撮り直す前は `npm run demo -- --reset` で作り直す。
 */
async function prepareSeating(page: Page) {
  const section = sectionByHeading(page, '卓の配置パターン');
  if (await section.getByRole('button', { name: 'この配置を新郎新婦に送る' }).count()) return;
  if (await section.getByRole('button', { name: '送るのをやめる' }).count()) return;
  await section.getByRole('button', { name: '配置を作る', exact: true }).click();
  await section.getByRole('button', { name: 'この内容で作る', exact: true }).click();
  const offer = section.getByRole('button', { name: 'この配置を新郎新婦に送る' });
  await offer.waitFor({ timeout: 15_000 });
  await offer.click();
  await section.getByRole('button', { name: '送るのをやめる' }).waitFor({ timeout: 15_000 });
}

/** 見出しの文字で、案件詳細のセクションを取る。 */
function sectionByHeading(page: Page, heading: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) });
}

async function main() {
  // tests/d1/*.browser.mjs と同じく、Playwright のブラウザが無い環境では手元の Chrome／Edge を指定できる
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    // ================= プランナー（PC） =================
    const staffPc = await browser.newContext({ ...PC, ...COMMON });
    const staffPcPage = await staffPc.newPage();

    await staffPcPage.goto(`${BASE}/login`);
    await shot(staffPcPage, '01-login', { device: 'pc' });

    await loginAsPlanner(staffPcPage);
    await staffPcPage.goto(`${BASE}/dashboard`);
    await shot(staffPcPage, '02-planner-dashboard', { device: 'pc' });

    await staffPcPage.goto(`${BASE}/cases`);
    await shot(staffPcPage, '03-case-list', { device: 'pc' });

    const caseHref = await rowHrefFor(staffPcPage, '/cases/', [DEMO_CASE_CODE]);
    await staffPcPage.goto(`${BASE}${caseHref}`);
    await prepareSeating(staffPcPage);
    await staffPcPage.goto(`${BASE}${caseHref}`);
    await shot(staffPcPage, '04-case-detail', { device: 'pc' });
    // 席次（#180〜#182）は案件詳細の中のセクション。セクションだけを切り出して撮る
    await shot(staffPcPage, '32-seating-layout', {
      device: 'pc',
      element: sectionByHeading(staffPcPage, '卓の配置パターン'),
    });

    await staffPcPage.goto(`${BASE}/submissions`);
    await shot(staffPcPage, '05-submissions-list', { device: 'pc' });

    // 一覧のどこにリンクがあっても（案件番号・宿題名）見つかるよう、行の中身で探す
    const reviewHref = await rowHrefFor(staffPcPage, '/submissions/', [
      DEMO_CASE_CODE,
      '料理コースの選択',
    ]);
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
    const textHref = await hrefFor(couplePcPage, '/mypage/tasks/', 'BGMリクエスト');
    const fileHref = await hrefFor(couplePcPage, '/mypage/tasks/', 'ゲストリスト提出');

    await couplePcPage.goto(`${BASE}${selectHref}`);
    await shot(couplePcPage, '10-couple-task-submit', { device: 'pc' });

    await couplePcPage.goto(`${BASE}${textHref}`);
    await shot(couplePcPage, '16-couple-task-submit-text', { device: 'pc' });

    await couplePcPage.goto(`${BASE}${fileHref}`);
    await shot(couplePcPage, '17-couple-task-submit-file', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/timeline`);
    await shot(couplePcPage, '18-couple-timeline', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/case`);
    await shot(couplePcPage, '19-couple-case-info', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/account`);
    await shot(couplePcPage, '20-couple-account', { device: 'pc' });

    await couplePcPage.goto(`${BASE}/mypage/seating`);
    await shot(couplePcPage, '31-couple-seating-editor', { device: 'pc' });

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
    await shot(staffSpPage, '23-mobile-submission-review', { device: 'sp' });

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
