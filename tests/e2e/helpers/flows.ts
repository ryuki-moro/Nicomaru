/**
 * 画面操作の部品。data-testid は無いので、ラベル・ロール・表示文字で選ぶ
 * （文言の正本は src/lib/constants.ts と各画面）。
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { futureDate } from './env';
import { waitForOtpCode } from './mail';
import type { PlannerAccount } from './admin';

export interface CaseInput {
  groomName: string;
  brideName: string;
  /** 主連絡先。こちら側の招待にだけ recipient_email が付く（6-6-1） */
  primaryContact: 'groom' | 'bride';
  contactEmail: string;
  planTypeName?: string;
}

export interface CreatedCase {
  caseId: string;
  caseCode: string;
  assignedCount: number;
  inviteUrls: { groom: string; bride: string };
}

/** 招待URLは APP_BASE_URL で組み立てられるので、パスだけ取り出して baseURL に付け直す */
function toPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

// ------------------------------------------------------------------ プランナー側

export async function loginAsPlanner(page: Page, planner: PlannerAccount): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'パスワードでログイン（プランナー・管理者）' }).click();
  await page.getByLabel('メールアドレス').fill(planner.email);
  await page.getByLabel('パスワード').fill(planner.password);
  await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
  await page.waitForURL(/\/dashboard/);
}

/** K03 案件登録 → 宿題の一括割当 → 招待URLの発行（モーダル）まで */
export async function createCase(page: Page, input: CaseInput): Promise<CreatedCase> {
  await page.goto('/cases/new');
  await expect(page.getByRole('heading', { name: '案件登録' })).toBeVisible();

  await page.getByLabel('挙式日（必須）').fill(futureDate(90));
  await page.getByLabel('新郎氏名（必須）').fill(input.groomName);
  await page.getByLabel('新婦氏名（必須）').fill(input.brideName);
  await page.getByLabel('主連絡先（必須）').selectOption(input.primaryContact);
  await page.getByLabel('連絡先（メール・必須）').fill(input.contactEmail);
  await page.getByLabel('連絡起点（必須）').selectOption('email');
  await page.getByLabel('プラン種別（必須）').selectOption({ label: input.planTypeName ?? '少人数婚' });
  await page.getByRole('button', { name: '登録する' }).click();

  await expect(page.getByRole('heading', { name: '案件を登録しました' })).toBeVisible({ timeout: 20_000 });

  const codeText = await page.getByText(/案件番号は .+ です。/).textContent();
  const caseCode = codeText?.match(/案件番号は (.+?) です。/)?.[1];
  if (!caseCode) throw new Error(`案件番号を読み取れない: ${codeText}`);

  const assignedText = await page.getByText(/宿題を\d+件割り当て/).textContent();
  const assignedCount = Number(assignedText?.match(/宿題を(\d+)件/)?.[1] ?? '0');

  const inviteUrls = {
    groom: await page.getByLabel('新郎の招待URL').inputValue(),
    bride: await page.getByLabel('新婦の招待URL').inputValue(),
  };

  await page.getByRole('button', { name: '閉じて案件一覧へ' }).click();
  await page.waitForURL(/\/cases$/);

  await page.getByRole('link', { name: caseCode, exact: true }).click();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  const caseId = page.url().match(/\/cases\/([0-9a-f-]{36})$/)?.[1];
  if (!caseId) throw new Error(`案件IDを URL から読み取れない: ${page.url()}`);

  return { caseId, caseCode, assignedCount, inviteUrls };
}

/** D02 提出物確認。案件番号で行を特定し、確認結果を登録して案件詳細へ戻るまで */
export async function reviewLatestSubmission(
  page: Page,
  kase: Pick<CreatedCase, 'caseId' | 'caseCode'>,
  result: { decision: 'confirmed' | 'needs_fix'; comment?: string },
): Promise<void> {
  await page.goto('/submissions');
  await page.getByRole('link', { name: kase.caseCode, exact: true }).first().click();
  await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/);

  await page.getByLabel(result.decision === 'needs_fix' ? '不備あり' : '確認済').check();
  if (result.comment) await page.getByLabel(/^コメント（/).fill(result.comment);
  await page.getByRole('button', { name: '確定する' }).click();
  await page.waitForURL(new RegExp(`/cases/${kase.caseId}$`));
}

// ------------------------------------------------------------------ 新郎新婦側

async function fillRegistration(page: Page, inviteUrl: string, who: { email: string; name: string }) {
  await page.goto(toPath(inviteUrl));
  await expect(page.getByRole('heading', { name: 'はじめての設定' })).toBeVisible();
  await page.getByLabel('メールアドレス').fill(who.email);
  await page.getByLabel('お名前').fill(who.name);
  await page.getByLabel('利用規約と個人情報の取り扱いに同意します').check();
  await page.getByRole('button', { name: '登録してマイページへ' }).click();
}

/**
 * U01〜U04 初回登録（主連絡先側）。招待の recipient_email と入力メールが一致するので、
 * 確認コード無しでそのままマイページへ入る（6-6-1）。
 */
export async function registerPrimaryPartner(
  context: BrowserContext,
  inviteUrl: string,
  who: { email: string; name: string },
): Promise<Page> {
  const page = await context.newPage();
  await fillRegistration(page, inviteUrl, who);
  await page.waitForURL(/\/mypage$/, { timeout: 20_000 });
  return page;
}

/**
 * 主連絡先でない側の初回登録。招待に recipient_email が無いので、
 * メールで届く6桁のワンタイムコードで本人確認してから案件へ紐付く（6-6-1）。
 */
export async function registerPartnerWithOtp(
  context: BrowserContext,
  inviteUrl: string,
  who: { email: string; name: string },
): Promise<Page> {
  const page = await context.newPage();
  const requestedAt = new Date();
  await fillRegistration(page, inviteUrl, who);

  const otpGroup = page.getByRole('group', { name: 'ワンタイムコード' });
  await expect(otpGroup).toBeVisible({ timeout: 20_000 });

  const code = await waitForOtpCode(who.email, { after: requestedAt });
  await page.getByLabel('ワンタイムコード 1桁目').click();
  await page.keyboard.type(code);
  await page.getByRole('button', { name: '確認してマイページへ' }).click();
  await page.waitForURL(/\/mypage$/, { timeout: 20_000 });
  return page;
}

/** 宿題一覧（/mypage/tasks）で宿題名の行を開く */
export async function openTask(page: Page, title: string): Promise<void> {
  await page.goto('/mypage/tasks');
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** 宿題一覧の行に表示される状態バッジ（TASK_STATUS_LABEL の文言）を確かめる */
export async function expectTaskStatus(page: Page, title: string, status: string): Promise<void> {
  await page.goto('/mypage/tasks');
  await expect(page.getByRole('link', { name: new RegExp(title) })).toContainText(status);
}

/** テキスト形式の宿題を提出する。成功すると一覧へ戻る */
export async function submitText(page: Page, answer: string): Promise<void> {
  await page.getByLabel('回答').fill(answer);
  await page.getByRole('button', { name: '提出する' }).click();
  await page.waitForURL(/\/mypage\/tasks$/);
}

/** テキスト形式の宿題を一時保存する。画面に留まり、保存した旨が出る */
export async function saveDraftText(page: Page, answer: string): Promise<void> {
  await page.getByLabel('回答').fill(answer);
  await page.getByRole('button', { name: '一時保存' }).click();
  await expect(page.getByText('入力中の内容を保存しました')).toBeVisible();
}
