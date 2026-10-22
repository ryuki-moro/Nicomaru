/** Issue #127: 新郎新婦の一覧とマイページを、専用案件の実ブラウザーで確認する。 */
import { expect, test } from '@playwright/test';

import { createPlanner } from './helpers/admin';
import { hasE2eEnv, uniqueEmail } from './helpers/env';
import { createCase, loginAsPlanner } from './helpers/flows';

test.skip(!hasE2eEnv, 'ローカル Supabase の接続情報が無いためスキップ');

test('回答方法・期限・状態タブとマイページの導線が表示される', async ({ page, browser }) => {
  const planner = await createPlanner();
  await loginAsPlanner(page, planner);

  const email = uniqueEmail('display');
  const kase = await createCase(page, {
    groomName: '表示確認 太郎',
    brideName: '表示確認 花子',
    primaryContact: 'groom',
    contactEmail: email,
  });
  expect(kase.assignedCount).toBe(8);

  const coupleContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const couple = await coupleContext.newPage();
    const appBase = new URL(page.url()).origin;
    const invite = new URL(kase.inviteUrls.groom);
    await couple.goto(`${appBase}${invite.pathname}${invite.search}`);
    await expect(couple.getByRole('heading', { name: 'はじめての設定' })).toBeVisible();
    await couple.getByLabel('メールアドレス').fill(email);
    await couple.getByLabel('お名前').fill('表示確認 太郎');
    await couple.getByLabel('利用規約と個人情報の取り扱いに同意します').check();
    const register = couple.getByRole('button', { name: '登録してマイページへ' });
    await expect(register).toBeEnabled();
    await register.click();
    await couple.waitForURL(/\/mypage$/, { timeout: 20_000 });

    const actions = couple.getByRole('heading', { name: '次にやること' }).locator('..');
    const actionLinks = actions.locator('a[href^="/mypage/tasks/"]');
    await expect(actionLinks).toHaveCount(3);
    for (const action of await actionLinks.all()) {
      await expect(action).toContainText(/あと\d+日/);
    }
    await expect(couple.getByText(`これから提出する宿題`)).toBeVisible();
    await expect(couple.getByText(`${kase.assignedCount}件`, { exact: true })).toBeVisible();

    const mainLink = couple.getByRole('link', { name: '宿題・提出物を見る' });
    await expect(mainLink).toHaveClass(/btn-primary/);
    await expect(mainLink).toHaveAttribute('href', '/mypage/tasks');
    const otherMenu = couple.getByRole('navigation', { name: 'そのほかのメニュー' });
    const timeline = otherMenu.getByRole('link', { name: '準備タイムラインを見る' });
    const notifications = otherMenu.getByRole('link', { name: 'お知らせを見る' });
    await expect(timeline).toHaveAttribute('href', '/mypage/timeline');
    await expect(notifications).toHaveAttribute('href', '/mypage/notifications');
    const timelineBox = await timeline.boundingBox();
    const notificationsBox = await notifications.boundingBox();
    expect(timelineBox).not.toBeNull();
    expect(notificationsBox).not.toBeNull();
    expect(Math.abs(timelineBox!.y - notificationsBox!.y)).toBeLessThan(2);

    await mainLink.click();
    await couple.waitForURL(/\/mypage\/tasks$/);
    const cards = couple.locator('main a[href^="/mypage/tasks/"]');
    await expect(cards).toHaveCount(kase.assignedCount);
    for (const method of ['選ぶ', '入力する', 'ファイルを送る', '確認のみ']) {
      await expect(cards.filter({ hasText: `回答方法：${method}` }).first()).toBeVisible();
    }
    await expect(cards.first()).toContainText(/あと\d+日/);

    const tabs = couple.getByRole('navigation', { name: '状態で絞り込む' });
    const tabLinks = tabs.getByRole('link');
    await expect(tabLinks).toHaveCount(6);
    for (const tab of await tabLinks.all()) {
      const box = await tab.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }

    await tabs.getByRole('link', { name: '確認済' }).click();
    await expect(tabs.getByRole('link', { name: '確認済' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(couple.getByText('このタブに表示する宿題はありません。')).toBeVisible();
    await couple.reload();
    await expect(tabs.getByRole('link', { name: '確認済' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await tabs.getByRole('link', { name: '対応不要' }).click();
    await expect(couple.getByText('このタブに表示する宿題はありません。')).toBeVisible();
    await couple.goto(`${appBase}/mypage/tasks?tab=unknown`);
    await expect(tabs.getByRole('link', { name: 'すべて' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(cards).toHaveCount(kase.assignedCount);
  } finally {
    await coupleContext.close();
  }
});
