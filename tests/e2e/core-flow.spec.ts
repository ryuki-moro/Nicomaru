/**
 * #19 一番大事な流れ（12-2）。
 *   案件登録 → 宿題割当 → 招待 → 新郎新婦の初回登録 → 提出 → 不備あり → 再提出 → 確認
 * と、2人で同じ宿題を共有する動き（6-7。一度バグを出した箇所）。
 *
 * アプリ本体は触らない。seed の式場・プラン・宿題テンプレートを前提にする。
 */
import { expect, test } from '@playwright/test';
import { createPlanner } from './helpers/admin';
import { hasE2eEnv, uniqueEmail } from './helpers/env';
import {
  createCase,
  expectTaskStatus,
  loginAsPlanner,
  openTask,
  registerPartnerWithOtp,
  registerPrimaryPartner,
  reviewLatestSubmission,
  saveDraftText,
  submitText,
} from './helpers/flows';

const TEXT_TASK = 'BGMリクエスト'; // seed の text 形式の宿題（少人数婚に含まれる）

test.skip(!hasE2eEnv, 'Supabase の接続情報（NEXT_PUBLIC_SUPABASE_URL 等）が無いのでスキップ');

test('案件登録から確認までを通しで行える', async ({ page, browser }) => {
  const planner = await createPlanner();
  await loginAsPlanner(page, planner);

  const groomEmail = uniqueEmail('groom');
  const kase = await createCase(page, {
    groomName: '山田 太郎',
    brideName: '山田 花子',
    primaryContact: 'groom',
    contactEmail: groomEmail,
  });
  // 少人数婚のテンプレートは6件（seed.sql plan_task_templates）
  expect(kase.assignedCount).toBe(6);

  // 新郎新婦は別ブラウザ（別セッション）
  const coupleContext = await browser.newContext();
  const groom = await registerPrimaryPartner(coupleContext, kase.inviteUrls.groom, {
    email: groomEmail,
    name: '山田 太郎',
  });
  await expect(groom.getByRole('heading', { name: '次にやること' })).toBeVisible();

  // 提出
  await openTask(groom, TEXT_TASK);
  await submitText(groom, '入場: Canon in D／歓談: ジャズ');
  await expectTaskStatus(groom, TEXT_TASK, '提出済');

  // プランナーが不備ありにする
  await reviewLatestSubmission(page, kase, {
    decision: 'needs_fix',
    comment: '退場曲もご記入ください',
  });

  // 新郎新婦にはプランナーのコメントが見え、同じ画面から再提出できる
  await expectTaskStatus(groom, TEXT_TASK, '不備あり');
  await openTask(groom, TEXT_TASK);
  await expect(groom.getByText('退場曲もご記入ください')).toBeVisible();
  await submitText(groom, '入場: Canon in D／歓談: ジャズ／退場: 星に願いを');
  await expectTaskStatus(groom, TEXT_TASK, '提出済');

  // プランナーが確認済にする
  await reviewLatestSubmission(page, kase, { decision: 'confirmed' });
  await expectTaskStatus(groom, TEXT_TASK, '確認済');

  await coupleContext.close();
});

test('片方が一時保存しても、もう片方が同じ宿題を提出できる', async ({ page, browser }) => {
  const planner = await createPlanner();
  await loginAsPlanner(page, planner);

  const brideEmail = uniqueEmail('bride');
  const groomEmail = uniqueEmail('groom');
  const kase = await createCase(page, {
    groomName: '佐藤 一郎',
    brideName: '佐藤 美咲',
    primaryContact: 'bride',
    contactEmail: brideEmail,
  });

  const brideContext = await browser.newContext();
  const groomContext = await browser.newContext();

  // 主連絡先（新婦）はメール一致でそのまま、新郎はワンタイムコードで本人確認して登録する
  const bride = await registerPrimaryPartner(brideContext, kase.inviteUrls.bride, {
    email: brideEmail,
    name: '佐藤 美咲',
  });
  const groom = await registerPartnerWithOtp(groomContext, kase.inviteUrls.groom, {
    email: groomEmail,
    name: '佐藤 一郎',
  });

  // 新婦が書きかけを保存する
  await openTask(bride, TEXT_TASK);
  await saveDraftText(bride, '（新婦の下書き）入場曲は検討中');

  // 新郎には下書きは見えないが、提出は通る（以前は 409 で二度と提出できなくなった）
  await openTask(groom, TEXT_TASK);
  await expect(groom.getByLabel('回答')).toHaveValue('');
  await submitText(groom, '入場: 結婚行進曲');

  await expectTaskStatus(groom, TEXT_TASK, '提出済');
  await expectTaskStatus(bride, TEXT_TASK, '提出済');

  await brideContext.close();
  await groomContext.close();
});
