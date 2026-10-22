/** Issue #127 単位1・2の比較撮影。ローカルのdemoデータを読み、画面・DBは変更しない。 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { chromium, devices, expect, type Page } from '@playwright/test';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) process.env[match[1]] ??= match[2].trim().replace(/^"(.*)"$/, '$1');
}
const stage = process.argv[2];
if (stage !== 'before' && stage !== 'after') throw new Error('before / after を指定してください');
const base = process.env.APP_BASE_URL!;
const mail = process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:54324';
if (![base, mail].every((url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname))) {
  throw new Error('ローカル環境だけで実行してください');
}
const directory = `docs/ui-review/p1/${stage}`;
mkdirSync(directory, { recursive: true });

async function login(page: Page) {
  const old = (await (await fetch(`${mail}/api/v1/messages?limit=200`)).json()).messages;
  const seen = new Set(old.map((item: { ID: string }) => item.ID));
  await page.goto(`${base}/login`);
  await page.getByLabel('メールアドレス').fill('demo-02-groom@demo.nicomaru.test');
  await page.getByRole('button', { name: 'ログインリンクを送信', exact: true }).click();
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const { messages } = await (await fetch(`${mail}/api/v1/messages?limit=100`)).json();
        const fresh = messages.find(
          (item: { ID: string; To: { Address: string }[] }) =>
            !seen.has(item.ID) &&
            item.To.some((to) => to.Address === 'demo-02-groom@demo.nicomaru.test'),
        );
        if (!fresh) return false;
        const detail = await (await fetch(`${mail}/api/v1/message/${fresh.ID}`)).json();
        code = (detail.HTML || detail.Text).match(/<strong>\s*(\d{6})\s*<\/strong>/)?.[1];
        return Boolean(code);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  for (const [index, digit] of [...code!].entries()) {
    await page.getByLabel(`ワンタイムコード ${index + 1}桁目`).fill(digit);
  }
  await page.waitForURL('**/mypage', { timeout: 30_000 });
}

async function capture(page: Page, name: string, fullPage: boolean) {
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  const navStyle = fullPage
    ? await page.addStyleTag({ content: '.fixed.inset-x-0.bottom-0{display:none!important}' })
    : null;
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage });
  await navStyle?.evaluate((style) => style.remove());
  if (
    stage === 'after' &&
    [
      '08-couple-mypage',
      '09-couple-tasks',
      '12-mobile-couple-mypage',
      '13-mobile-couple-tasks',
    ].includes(name)
  ) {
    copyFileSync(`${directory}/${name}.png`, `docs/screenshots/${name}.png`);
  }
}

const browser = await chromium.launch({ channel: process.env.P1_BROWSER_CHANNEL || undefined });
const results: string[] = [];
try {
  const auth = await browser.newContext({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  auth.setDefaultNavigationTimeout(120_000);
  await login(await auth.newPage());
  const storageState = await auth.storageState();
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      ...(mobile ? devices['iPhone 13'] : { viewport: { width: 1440, height: 900 } }),
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      storageState,
    });
    context.setDefaultNavigationTimeout(120_000);
    const page = await context.newPage();
    await page.goto(`${base}/mypage`);
    await expect(page.getByRole('heading', { name: '次にやること' })).toBeVisible();
    if (stage === 'after') {
      const actions = page
        .getByRole('heading', { name: '次にやること' })
        .locator('..')
        .locator('li');
      expect(await actions.count()).toBeLessThanOrEqual(3);
      for (const action of await actions.all())
        await expect(action).toContainText(/あと\d+日|今日まで|\d+日過ぎています/);
      const menu = page.getByRole('navigation', { name: 'そのほかのメニュー' });
      await expect(menu.getByRole('link')).toHaveCount(2);
      const boxes = await menu
        .getByRole('link')
        .evaluateAll((links) => links.map((link) => link.getBoundingClientRect().top));
      expect(boxes[0]).toBe(boxes[1]);
      await expect(page.getByRole('link', { name: '宿題・提出物を見る', exact: true })).toHaveClass(
        /btn-primary/,
      );
      results.push(`${mobile ? 'SP' : 'PC'}: 相対期限、最大3件、主ボタン、補助リンク1行`);
    }
    await capture(page, mobile ? '12-mobile-couple-mypage' : '08-couple-mypage', !mobile);
    if (mobile) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await capture(page, '12-mobile-couple-mypage-bottom', false);
    }
    await page.goto(`${base}/mypage/tasks`);
    if (stage === 'after') {
      for (const label of ['選ぶ', '入力する', 'ファイルを送る', '確認のみ']) {
        await expect(page.getByText(`回答方法：${label}`, { exact: true }).first()).toBeVisible();
      }
      const tabs = page.getByRole('navigation', { name: '状態で絞り込む' });
      await expect(tabs.getByRole('link')).toHaveCount(6);
      for (const link of await tabs.getByRole('link').all()) {
        const box = await link.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      results.push(`${mobile ? 'SP' : 'PC'}: 回答方法4種、全6タブ表示、横はみ出しなし`);
    }
    await capture(page, mobile ? '13-mobile-couple-tasks' : '09-couple-tasks', !mobile);
    for (const [tab, label] of [
      ['confirmed', '確認済'],
      ['waived', '対応不要'],
      ['needs_fix', '不備あり'],
    ]) {
      await page
        .getByRole('navigation', { name: '状態で絞り込む' })
        .getByRole('link', { name: label, exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
      await expect(
        page
          .getByRole('navigation', { name: '状態で絞り込む' })
          .getByRole('link', { name: label, exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      if (stage === 'after' && tab !== 'needs_fix') {
        await expect(page.locator('main')).not.toContainText(
          /あと\d+日|今日まで|\d+日過ぎています/,
        );
      }
      await capture(page, `${mobile ? '13-mobile' : '09-pc'}-tasks-${tab}`, !mobile);
    }
    if (stage === 'after')
      results.push(`${mobile ? 'SP' : 'PC'}: 状態フィルタ遷移・現在地、確認済/対応不要の期限抑制`);
    await context.close();
  }
  await auth.close();
  writeFileSync(
    `${directory}/result.json`,
    JSON.stringify({ stage, capturedAt: new Date().toISOString(), base, results }, null, 2) + '\n',
  );
  console.log(`${stage}: 撮影と${results.length}組の確認完了`);
} finally {
  await browser.close();
}
