import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { request, chromium } from '@playwright/test';

const origin = 'http://127.0.0.1:3104';
const { users } = JSON.parse(await readFile('.wrangler/app-local/credentials.json', 'utf8'));

test('案件一覧の2つの検索解除リンクがq/pageを消しscope/sortを保つ', async () => {
  const auth = await request.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Origin: origin },
    timeout: 120_000,
  });
  const response = await auth.post('/api/auth/password-login', { data: users.adminA });
  assert.equal(response.status(), 200, 'admin login');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const context = await browser.newContext({ storageState: await auth.storageState() });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);
  await mkdir('docs/ui-review/issue-186', { recursive: true });
  try {
    const searched = `${origin}/cases?q=NO_MATCH_ISSUE_186&page=3&scope=archived&sort=risk`;
    await page.goto(searched);
    await page.screenshot({ path: 'docs/ui-review/issue-186/search-result.png', fullPage: true });
    const clear = page.getByRole('link', { name: '検索を解除', exact: true });
    assert.equal(await clear.getAttribute('href'), '/cases?scope=archived&sort=risk');
    await clear.click();
    await page.waitForURL(`${origin}/cases?scope=archived&sort=risk`);
    assert.equal(await page.locator('#q').inputValue(), '');
    await page.screenshot({
      path: 'docs/ui-review/issue-186/cleared-archived.png',
      fullPage: true,
    });

    await page.goto(`${origin}/cases?page=3&scope=archived&sort=risk`);
    await page.locator('#q').fill('NO_MATCH_ISSUE_186');
    await page.getByRole('button', { name: '絞り込む' }).click();
    await page.waitForURL((url) => {
      const parsed = new URL(url);
      return (
        parsed.pathname === '/cases' &&
        parsed.searchParams.get('q') === 'NO_MATCH_ISSUE_186' &&
        parsed.searchParams.get('scope') === 'archived' &&
        parsed.searchParams.get('sort') === 'risk'
      );
    });
    await page.locator('#q').fill('入力途中のキーワード');
    const clearFromEmpty = page.getByRole('link', { name: '検索を解除して一覧に戻る' });
    assert.equal(await clearFromEmpty.getAttribute('href'), '/cases?scope=archived&sort=risk');
    await clearFromEmpty.click();
    await page.waitForURL(`${origin}/cases?scope=archived&sort=risk`);
    assert.equal(await page.locator('#q').inputValue(), '');

    await page.goto(`${origin}/cases?q=NO_MATCH_ISSUE_186&page=3&scope=active&sort=risk`);
    const clearActive = page.getByRole('link', { name: '検索を解除して一覧に戻る' });
    assert.equal(await clearActive.getAttribute('href'), '/cases?sort=risk');
    await clearActive.click();
    await page.waitForURL(`${origin}/cases?sort=risk`);
    assert.equal(await page.locator('#q').inputValue(), '');
    assert.ok((await page.locator('main a[href^="/cases/"]').count()) > 0, '案件一覧を表示');
    await page.screenshot({ path: 'docs/ui-review/issue-186/cleared-active.png', fullPage: true });
  } finally {
    await context.close();
    await browser.close();
    await auth.dispose();
  }
});
