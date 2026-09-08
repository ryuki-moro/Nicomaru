/**
 * #19 権限・エラーまわり（4-3／6-3）。
 *   - 未ログインで保護ページを開くとログインへ戻る
 *   - /api は未ログインでもリダイレクトせず 401 JSON を返す
 *   - 役割の違う画面は自分の入口へ戻される
 *   - 権限外・不存在の案件はエラー画面（P04）
 *   - セッションが切れるとログイン画面へ戻る
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createPlanner } from './helpers/admin';
import { hasE2eEnv, uniqueEmail } from './helpers/env';
import { createCase, loginAsPlanner, registerPrimaryPartner } from './helpers/flows';

test.skip(!hasE2eEnv, 'Supabase の接続情報（NEXT_PUBLIC_SUPABASE_URL 等）が無いのでスキップ');

test('未ログインで保護ページを開くと、戻り先つきでログイン画面へ', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForURL(/\/login\?next=%2Fdashboard$/);
  await expect(page.getByRole('heading', { name: 'ログイン' })).toBeVisible();
});

test('/api は未ログインでも 401 の JSON を返す（ログイン画面のHTMLを返さない）', async ({ request }) => {
  const res = await request.get('/api/ai/status');
  expect(res.status()).toBe(401);
  const body = (await res.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe('UNAUTHENTICATED');
});

test.describe('ログイン済みの権限', () => {
  test.describe.configure({ mode: 'serial' });

  let plannerContext: BrowserContext;
  let planner: Page;
  let coupleContext: BrowserContext;
  let couple: Page;

  test.beforeAll(async ({ browser }) => {
    plannerContext = await browser.newContext();
    planner = await plannerContext.newPage();
    await loginAsPlanner(planner, await createPlanner());

    const groomEmail = uniqueEmail('groom');
    const kase = await createCase(planner, {
      groomName: '高橋 健',
      brideName: '高橋 結',
      primaryContact: 'groom',
      contactEmail: groomEmail,
    });
    coupleContext = await browser.newContext();
    couple = await registerPrimaryPartner(coupleContext, kase.inviteUrls.groom, {
      email: groomEmail,
      name: '高橋 健',
    });
  });

  test.afterAll(async () => {
    await plannerContext?.close();
    await coupleContext?.close();
  });

  test('新郎新婦がプランナー画面を開くとマイページへ戻される', async () => {
    await couple.goto('/dashboard');
    await couple.waitForURL(/\/mypage$/);
  });

  test('存在しない案件は権限外と同じくエラー画面へ（P04）', async () => {
    await planner.goto('/cases/00000000-0000-4000-8000-000000000000');
    await planner.waitForURL(/\/error$/);
    await expect(planner.getByRole('heading', { name: 'ページを表示できませんでした' })).toBeVisible();
    await expect(planner.getByRole('link', { name: 'ログイン画面へ戻る' })).toBeVisible();
  });

  test('system_admin 専用画面は 403 の文面', async () => {
    await planner.goto('/system');
    await planner.waitForURL(/\/error\?code=403$/);
    await expect(planner.getByRole('heading', { name: 'このページは表示できません' })).toBeVisible();
  });

  test('セッションが切れるとログイン画面へ戻る（新郎新婦）', async () => {
    await coupleContext.clearCookies();
    await couple.goto('/mypage/tasks');
    await couple.waitForURL(/\/login\?next=%2Fmypage%2Ftasks$/);
  });

  test('セッションが切れるとログイン画面へ戻る（プランナー）', async () => {
    await plannerContext.clearCookies();
    await planner.goto('/cases');
    await planner.waitForURL(/\/login\?next=%2Fcases$/);
  });
});
