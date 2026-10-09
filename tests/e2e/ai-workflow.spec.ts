/**
 * OPS-18: 匿名の要点 → UI 依頼 → ai_worker の claim/complete → 人の採用 → コメント欄。
 * 外部 AI・Ollama は呼ばず、成功状態の直接書き換えや API の応答差し替えも行わない。
 * CI のローカル Supabase だけで実行し、レビュー確定・通知送信はしない。
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { adminClient, createPlanner } from './helpers/admin';
import { connectLocalAiWorker } from './helpers/ai-worker';
import { hasE2eEnv, uniqueEmail } from './helpers/env';
import {
  createCase,
  loginAsPlanner,
  openTask,
  registerPrimaryPartner,
  submitText,
} from './helpers/flows';

test.skip(!process.env.CI, '使い捨てローカル Supabase を使用する CI 専用のワーカー連携試験');

test('AI下書きは専用ワーカーで処理され、人が採用してからコメント欄へ入る', async ({
  page,
  browser,
}) => {
  expect(hasE2eEnv, 'CI の Supabase 接続情報が必要です').toBe(true);
  const workerName = `e2e-workflow-${randomUUID()}`;
  const worker = await connectLocalAiWorker(workerName);
  const coupleContext = await browser.newContext();
  let caseId: string | undefined;
  try {
    expect(await worker.deniesDirectAccess()).toEqual({ read: true, write: true });
    await worker.ping();

    const planner = await createPlanner();
    await loginAsPlanner(page, planner);
    const email = uniqueEmail('ai-workflow-groom');
    const groomName = '模擬 太郎';
    const brideName = '模擬 花子';
    const kase = await createCase(page, {
      groomName,
      brideName,
      primaryContact: 'groom',
      contactEmail: email,
    });
    caseId = kase.caseId;
    const groom = await registerPrimaryPartner(coupleContext, kase.inviteUrls.groom, {
      email,
      name: groomName,
    });
    const answer = '入場曲: 模擬音源A。提出本文はコメント下書きへ渡さない。';
    await openTask(groom, 'BGMリクエスト');
    const taskId = new URL(groom.url()).pathname.split('/').pop()!;
    await submitText(groom, answer);

    await page.goto('/submissions');
    await page.getByRole('link', { name: kase.caseCode, exact: true }).first().click();
    await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/);
    const submissionId = new URL(page.url()).pathname.split('/').pop()!;
    await expect(page.getByText('AIによる下書き（要確認）', { exact: true })).toBeVisible();
    await page.getByLabel('不備あり', { exact: true }).check();
    const comment = page.getByLabel('コメント（必須）', { exact: true });
    const memo = '退場曲を追記してほしい';
    await comment.fill(memo);

    const createdResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/ai/jobs' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'AIに文面の下書きを頼む', exact: true }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const queued = (await created.json()) as { id: string; status: string };
    expect(queued.status).toBe('queued');
    expect(queued.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByRole('button', { name: 'コメント欄に入れる' })).toHaveCount(0);
    await expect(comment).toHaveValue(memo);
    expect(await worker.completeDraft(queued.id, { text: '未取得のジョブは完了できない' })).toBe(
      false,
    );

    const claimed = await worker.claimDraft(caseId, queued.id);
    expect(claimed.job_type).toBe('draft');
    expect(claimed.related_task_id).toBe(taskId);
    expect(claimed.attempts).toBe(1);
    expect(claimed.prompt_text).toBeTruthy();
    expect(claimed.input_ref).toEqual({
      text: `宿題: BGMリクエスト\n状況: 提出内容に直していただきたい点があります\n伝えたいこと: ${memo}`,
      params: { purpose: 'submission_review_comment' },
    });
    const workerInput = JSON.stringify(claimed.input_ref);
    for (const excluded of [groomName, brideName, email, planner.email, answer]) {
      expect(workerInput).not.toContain(excluded);
    }
    const processing = await page.request.get(`/api/ai/jobs/${queued.id}`);
    expect(processing.status()).toBe(200);
    expect((await processing.json()).status).toBe('processing');

    const draft = 'ご提出ありがとうございます。退場時に希望する曲名も追記をお願いします。';
    expect(
      await worker.completeDraft(queued.id, {
        text: draft,
        cautions: ['曲名は担当者が確認してください'],
      }),
    ).toBe(true);
    // ポーリングによる実 API の応答を待つ。結果はまだフォームに採用しない。
    await expect(page.getByText(draft, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(comment).toHaveValue(memo);
    const done = await page.request.get(`/api/ai/jobs/${queued.id}`);
    expect(done.status()).toBe(200);
    expect((await done.json()).status).toBe('done');
    expect(await worker.completeDraft(queued.id, { text: '完了済みの出力は上書きできない' })).toBe(
      false,
    );

    const reviewedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/ai/jobs/${queued.id}` &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'コメント欄に入れる', exact: true }).click();
    const reviewed = await reviewedResponse;
    expect(reviewed.status()).toBe(200);
    expect((await reviewed.json()).status).toBe('confirmed');
    await expect(comment).toHaveValue(draft);
    await expect(page.getByRole('button', { name: 'コメント欄に入れる' })).toHaveCount(0);
    const confirmed = await page.request.get(`/api/ai/jobs/${queued.id}`);
    expect(confirmed.status()).toBe(200);
    expect((await confirmed.json()).status).toBe('confirmed');

    // 人が直せる欄までの反映。採用だけで提出の確認・通知を確定しない。
    await comment.fill(`${draft}\n担当者が確認してからご連絡します。`);
    await expect(comment).toHaveValue(`${draft}\n担当者が確認してからご連絡します。`);
    const submission = await adminClient()
      .from('task_submissions')
      .select('review_status, planner_feedback, reviewed_at')
      .eq('id', submissionId)
      .single();
    expect(submission.error).toBeNull();
    expect(submission.data).toEqual({
      review_status: 'submitted',
      planner_feedback: null,
      reviewed_at: null,
    });
  } finally {
    await coupleContext.close();
    await worker.close();
    // 自分が作った fixture だけを片付ける。Service Role で処理結果は書き込まない。
    if (caseId) {
      const { error } = await adminClient().from('ai_jobs').delete().eq('case_id', caseId);
      if (error) throw new Error('AI workflow fixture のジョブを片付けられませんでした');
    }
    const { error } = await adminClient()
      .from('ai_worker_heartbeats')
      .delete()
      .eq('worker_name', workerName);
    if (error) throw new Error('AI workflow fixture の心拍を片付けられませんでした');
  }
});
