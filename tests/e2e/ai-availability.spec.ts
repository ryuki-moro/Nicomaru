/**
 * #19 AI補助が止まっているとき（7-1／7-3(4)）。
 * ワーカーの心拍（ai_worker_heartbeats）が10分途切れたら依頼ボタンを出さず、
 * 手作業の案内に切り替わる。D03 準備シートで確かめる（提出物が無くても開ける）。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { clearAiWorkerHeartbeats, createPlanner, setAiWorkerHeartbeat } from './helpers/admin';
import { hasE2eEnv, uniqueEmail } from './helpers/env';
import { createCase, loginAsPlanner } from './helpers/flows';

const UNAVAILABLE = 'ただいまAI補助を利用できません';
const REQUEST_BUTTON = /^AIに/;

test.skip(!hasE2eEnv, 'Supabase の接続情報（NEXT_PUBLIC_SUPABASE_URL 等）が無いのでスキップ');

test.describe('AI補助の利用可否', () => {
  test.describe.configure({ mode: 'serial' });

  let context: BrowserContext;
  let planner: Page;
  let sheetPath: string;

  test.beforeAll(async ({ browser }) => {
    await clearAiWorkerHeartbeats();
    context = await browser.newContext();
    planner = await context.newPage();
    await loginAsPlanner(planner, await createPlanner());
    const kase = await createCase(planner, {
      groomName: '鈴木 大地',
      brideName: '鈴木 さくら',
      primaryContact: 'groom',
      contactEmail: uniqueEmail('groom'),
    });
    sheetPath = `/cases/${kase.caseId}/sheet`;
  });

  test.afterAll(async () => {
    await clearAiWorkerHeartbeats();
    await context?.close();
  });

  test('心拍が無いときは「利用できません」と出て、依頼ボタンが無い', async () => {
    await planner.goto(sheetPath);
    await expect(planner.getByRole('heading', { name: 'AIによる要点の下書き（要確認）' })).toBeVisible();
    await expect(planner.getByText(UNAVAILABLE)).toBeVisible();
    await expect(planner.getByRole('button', { name: REQUEST_BUTTON })).toHaveCount(0);
  });

  test('心拍が10分以内なら依頼ボタンが出る', async () => {
    await setAiWorkerHeartbeat(1);
    await planner.goto(sheetPath);
    await expect(planner.getByRole('button', { name: REQUEST_BUTTON })).toBeVisible();
    await expect(planner.getByText(UNAVAILABLE)).toHaveCount(0);
  });

  test('心拍が10分以上前なら再び「利用できません」になる', async () => {
    await setAiWorkerHeartbeat(11);
    await planner.goto(sheetPath);
    await expect(planner.getByText(UNAVAILABLE)).toBeVisible();
    await expect(planner.getByRole('button', { name: REQUEST_BUTTON })).toHaveCount(0);
  });
});
