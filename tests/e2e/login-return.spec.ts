/**
 * ログインをまたいで元の画面へ戻る（#104、4-2）。
 *   - 未ログインで絞り込み付きの画面を開く → ログイン → 同じ URL に着く
 *   - 戻り先には一覧の絞り込み（tab・page）だけを載せ、トークン類は持ち出さない
 *   - ワンタイム認証メールのリンクにも同じ戻り先が載り、リンクからでも戻れる
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createPlanner } from './helpers/admin';
import { hasE2eEnv, uniqueEmail } from './helpers/env';
import { createCase, loginAsPlanner, registerPrimaryPartner } from './helpers/flows';
import { waitForOtpMail } from './helpers/mail';

test.skip(!hasE2eEnv, 'Supabase の接続情報（NEXT_PUBLIC_SUPABASE_URL 等）が無いのでスキップ');

const DESTINATION = '/mypage/tasks?tab=needs_fix';

/** 案件を作り、主連絡先の新郎を登録する。ログイン済みのコンテキストは閉じる */
async function registeredGroom(browser: Browser): Promise<string> {
  const plannerContext = await browser.newContext();
  const planner = await plannerContext.newPage();
  await loginAsPlanner(planner, await createPlanner());
  const groomEmail = uniqueEmail('groom');
  const kase = await createCase(planner, {
    groomName: '中村 蓮',
    brideName: '中村 葵',
    primaryContact: 'groom',
    contactEmail: groomEmail,
  });
  const coupleContext = await browser.newContext();
  await registerPrimaryPartner(coupleContext, kase.inviteUrls.groom, {
    email: groomEmail,
    name: '中村 蓮',
  });
  await coupleContext.close();
  await plannerContext.close();
  // 初回登録もOTPを発行するため、Authのmax_frequency（1秒）を空ける。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return groomEmail;
}

/** 未ログインで絞り込み付きの宿題一覧を開き、ログイン画面でコードを要求する */
async function requestCodeFromProtectedPage(page: Page, email: string) {
  await page.goto(`${DESTINATION}&token=private-value&page=x!`);
  await page.waitForURL(/\/login\?next=/);
  expect(new URL(page.url()).searchParams.get('next')).toBe(DESTINATION);
  expect(page.url()).not.toContain('private-value');

  const requestedAt = new Date();
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByRole('button', { name: 'ログインリンクを送信' }).click();
  await expect(page.getByRole('group', { name: 'ワンタイムコード' })).toBeVisible();
  return waitForOtpMail(email, { after: requestedAt });
}

async function expectBackOnDestination(page: Page) {
  await page.waitForURL((url) => `${url.pathname}${url.search}` === DESTINATION, {
    timeout: 20_000,
  });
  await expect(page.getByRole('link', { name: '不備あり' })).toHaveAttribute(
    'aria-current',
    'page',
  );
}

test.describe('未ログインからログインして元の画面へ戻る', () => {
  test.describe.configure({ mode: 'serial' });

  let groomEmail: string;

  test.beforeEach(async ({ browser }) => {
    groomEmail = await registeredGroom(browser);
  });

  test('6桁コードでログインすると、絞り込み付きの同じ URL に着く', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const mail = await requestCodeFromProtectedPage(page, groomEmail);

    // メールのリンク経路にも戻り先が載っている。Supabase は戻り先のホスト名が Site URL と
    // 違うと黙って Site URL に落とすので、ここで設定のずれ（next の消失）を検知する
    const link = mail.links.find((href) => new URL(href).pathname === '/login/link');
    expect(link).toBeDefined();
    expect(new URL(link!).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(link!).searchParams.get('next')).toBe(DESTINATION);
    expect(new URLSearchParams(new URL(link!).hash.slice(1)).get('e')).toBe(groomEmail);
    expect(new URLSearchParams(new URL(link!).hash.slice(1)).get('c')).toBe(mail.code);

    await page.getByLabel('ワンタイムコード 1桁目').click();
    await page.keyboard.type(mail.code);
    await expectBackOnDestination(page);
    await context.close();
  });

  test('同じブラウザでメールのリンクを開いても、同じ URL に着く', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const mail = await requestCodeFromProtectedPage(page, groomEmail);

    const link = mail.links.find((href) => new URL(href).pathname === '/login/link');
    expect(link).toBeDefined();
    await page.goto(link!);
    await page.getByRole('button', { name: 'ログインする', exact: true }).click();
    await expectBackOnDestination(page);
    await context.close();
  });
});
