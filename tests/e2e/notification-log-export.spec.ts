/** S03 CSV: 実PostgRESTの1000件上限、JST境界、画面のエラーとダウンロード。 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test, type Download, type Page } from '@playwright/test';

import { adminClient } from './helpers/admin';
import { e2eEnv, hasE2eEnv, PLANNER_PASSWORD, uniqueEmail, VENUE_ID } from './helpers/env';
import { loginAsPlanner } from './helpers/flows';

const EXPORT_PATH = '/api/system/notification-logs.csv';
const EXPORT_ROUTE = '**/api/system/notification-logs.csv*';
const EXPORT_DAY = '2001-02-03';
const CSV_HEADER = '日時,式場,案件番号,チャネル,種別,送信結果,プロバイダ側メッセージID';
const COMMUNICATION_ERROR_MESSAGE = '通信に失敗しました。時間をおいてお試しください';

function hasLocalSupabase(): boolean {
  if (!hasE2eEnv) return false;
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(e2eEnv.supabaseUrl).hostname);
  } catch {
    return false;
  }
}

test.skip(!hasLocalSupabase(), 'ローカルSupabaseの接続情報がないためスキップ');

interface ExportAccount {
  authUserId: string;
  profileId: string;
  email: string;
  password: string;
  displayName: string;
}

async function createExportAccount(role: 'system_admin' | 'planner'): Promise<ExportAccount> {
  const admin = adminClient();
  const email = uniqueEmail(`csv-${role}`);
  const displayName = `CSV E2E ${role}`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PLANNER_PASSWORD, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`CSV用アカウント作成失敗: ${error?.message}`);
  const authUserId = data.user.id;
  const profile = await admin.from('user_profiles').insert({
    auth_user_id: authUserId,
    venue_id: role === 'system_admin' ? null : VENUE_ID,
    role, email, display_name: displayName, status: 'active',
  }).select('id').single();
  if (profile.error || !profile.data) {
    await admin.auth.admin.deleteUser(authUserId);
    throw new Error(`CSV用プロフィール作成失敗: ${profile.error?.message}`);
  }
  return { authUserId, profileId: profile.data.id, email, password: PLANNER_PASSWORD, displayName };
}

async function loginAsSystemAdmin(page: Page, account: ExportAccount) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'パスワードでログイン（プランナー・管理者）' }).click();
  await page.getByLabel('メールアドレス').fill(account.email);
  await page.getByLabel('パスワード').fill(account.password);
  await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
  await page.waitForURL(/\/system$/);
  await expect(page.getByRole('form', { name: '通知ログCSV出力' })).toBeVisible();
}

async function downloadCsv(page: Page): Promise<Download> {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ログをCSV出力', exact: true }).click();
  return downloaded;
}

async function readDownload(download: Download): Promise<Buffer> {
  expect(await download.failure()).toBeNull();
  const filename = await download.path();
  if (!filename) throw new Error('ダウンロードファイルが見つかりません');
  return readFile(filename);
}

test.describe('通知ログCSV出力', () => {
  let systemAdmin: ExportAccount;
  let planner: ExportAccount;
  let notificationId: string | undefined;
  const prefix = `csv-${randomUUID()}`;
  const privateBody = `出力禁止の通知本文 ${prefix}`;
  const privateTitle = `出力禁止の通知件名 ${prefix}`;
  const logRows: { id: string; created_at: string; provider_message_id: string; inPeriod: boolean }[] = [];

  test.beforeAll(async () => {
    systemAdmin = await createExportAccount('system_admin');
    planner = await createExportAccount('planner');
    // sent に固定し、通知ディスパッチの対象を作らない。
    const notification = await adminClient().from('notifications').insert({
      venue_id: VENUE_ID,
      // 受信者本人ではないsystem_adminが、全体参照のRLS分岐で出力する。
      recipient_user_id: planner.profileId,
      created_by: systemAdmin.profileId,
      channel: 'email', notification_type: 'info',
      title: privateTitle, body: privateBody,
      status: 'sent', sent_at: '2001-02-03T03:04:05Z',
    }).select('id').single();
    if (notification.error || !notification.data) {
      throw new Error(`CSV用通知作成失敗: ${notification.error?.message}`);
    }
    notificationId = notification.data.id;

    for (let index = 0; index < 1001; index++) {
      logRows.push({
        id: randomUUID(), created_at: '2001-02-03T03:04:05.123456Z',
        provider_message_id: `${prefix}-tie-${index}`, inPeriod: true,
      });
    }
    // 同時刻グループの途中でページが変わる。Dateへの変換で落ちる隣接マイクロ秒も置く。
    for (const [label, created_at, inPeriod] of [
      ['start', '2001-02-02T15:00:00.000000Z', true],
      ['end', '2001-02-03T14:59:59.999999Z', true],
      ['microsecond', '2001-02-03T03:04:05.123455Z', true],
      ['before', '2001-02-02T14:59:59.999999Z', false],
      ['after', '2001-02-03T15:00:00.000000Z', false],
    ] as const) {
      logRows.push({ id: randomUUID(), created_at, provider_message_id: `${prefix}-${label}`, inPeriod });
    }
    for (let offset = 0; offset < logRows.length; offset += 500) {
      const batch = logRows.slice(offset, offset + 500).map((row, index) => ({
        id: row.id, notification_id: notificationId,
        provider: 'email', status: 'success', attempt_no: offset + index + 1,
        provider_message_id: row.provider_message_id, created_at: row.created_at,
        response_json: { privateBody, recipientEmail: planner.email },
      }));
      const { error } = await adminClient().from('notification_logs').insert(batch);
      if (error) throw new Error(`CSV用ログ作成失敗: ${error.message}`);
    }
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    if (notificationId) {
      // 通知の削除で、所有するログだけがFKにより削除される。
      const { error } = await adminClient().from('notifications').delete().eq('id', notificationId);
      if (error) failures.push(error.message);
    }
    for (const account of [systemAdmin, planner]) {
      if (!account) continue;
      const profile = await adminClient().from('user_profiles').delete().eq('id', account.profileId);
      if (profile.error) failures.push(profile.error.message);
      const auth = await adminClient().auth.admin.deleteUser(account.authUserId);
      if (auth.error) failures.push(auth.error.message);
    }
    if (failures.length) throw new Error(`CSV用fixtureの清掃失敗: ${failures.join('; ')}`);
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSystemAdmin(page, systemAdmin);
  });

  test('1000件超の同時刻ログ・JST境界・マイクロ秒を欠落なくダウンロードする', async ({ page }) => {
    await page.getByLabel('開始日（任意）').fill(EXPORT_DAY);
    await page.getByLabel('終了日（任意）').fill(EXPORT_DAY);
    const responsePromise = page.waitForResponse((response) => response.url().includes(EXPORT_PATH));
    const download = await downloadCsv(page);
    const response = await responsePromise;

    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['x-truncated']).toBe('false');
    const requested = new URL(response.url());
    expect(requested.searchParams.get('from')).toBe(EXPORT_DAY);
    expect(requested.searchParams.get('to')).toBe(EXPORT_DAY);
    expect(download.suggestedFilename()).toBe('notification-logs.csv');
    const content = await readDownload(download);
    expect([...content.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = content.toString('utf8');
    expect(csv.split('\r\n')[0]).toBe(`\uFEFF${CSV_HEADER}`);
    const ids = csv.split('\r\n').slice(1)
      .map((row) => row.split(',').at(-1))
      .filter((id): id is string => Boolean(id?.startsWith(prefix)));
    const expected = logRows.filter((row) => row.inPeriod)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
      .map((row) => row.provider_message_id);
    expect(expected).toHaveLength(1004);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(csv).not.toContain(`${prefix}-before`);
    expect(csv).not.toContain(`${prefix}-after`);
    expect(csv).not.toContain(privateTitle);
    expect(csv).not.toContain(privateBody);
    expect(csv).not.toContain(systemAdmin.email);
    expect(csv).not.toContain(systemAdmin.displayName);
    expect(csv).not.toContain(planner.email);
    expect(csv).not.toContain(planner.displayName);
    await expect(page.getByRole('status')).toContainText('CSVのダウンロードを開始しました。');
  });

  test('空欄は期間を省略し、取得中の操作を止め、Blob URLを解放する', async ({ page }) => {
    await page.addInitScript(() => {
      const state = { created: [] as string[], revoked: [] as string[], cacheModes: [] as string[] };
      (window as unknown as { csvDownloadState: typeof state }).csvDownloadState = state;
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        state.created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => { state.revoked.push(url); revoke(url); };
      const fetchOriginal = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input).includes('/api/system/notification-logs.csv')) state.cacheModes.push(init?.cache ?? '');
        return fetchOriginal(input, init);
      };
    });
    await page.reload();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let requestedUrl: URL | undefined;
    let requests = 0;
    await page.route(EXPORT_ROUTE, async (route) => {
      requests++;
      requestedUrl = new URL(route.request().url());
      await pending;
      await route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: `\uFEFF${CSV_HEADER}\r\n` });
    });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('form', { name: '通知ログCSV出力' }).evaluate((element) => {
      const form = element as HTMLFormElement;
      form.requestSubmit();
      form.requestSubmit();
    });
    try {
      await expect(page.getByRole('button', { name: '取得中…' })).toBeDisabled();
      await expect(page.getByLabel('開始日（任意）')).toBeDisabled();
      await expect(page.getByLabel('終了日（任意）')).toBeDisabled();
      await expect(page.getByRole('form', { name: '通知ログCSV出力' })).toHaveAttribute('aria-busy', 'true');
      await expect.poll(() => requestedUrl?.search).toBe('');
      expect(requests).toBe(1);
    } finally {
      release();
    }
    await readDownload(await downloaded);
    await expect(page.getByRole('button', { name: 'ログをCSV出力', exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => {
      const state = (window as unknown as { csvDownloadState: { created: string[]; revoked: string[]; cacheModes: string[] } }).csvDownloadState;
      return { created: state.created.length, freed: state.created.every((url) => state.revoked.includes(url)), cache: state.cacheModes };
    })).toEqual({ created: 1, freed: true, cache: ['no-store'] });
  });

  test('逆転した期間は実APIの400を終了日直下とサマリに表示する', async ({ page }) => {
    await page.getByLabel('開始日（任意）').fill('2001-02-04');
    await page.getByLabel('終了日（任意）').fill(EXPORT_DAY);
    const responded = page.waitForResponse((response) => response.url().includes(EXPORT_PATH));
    await page.getByRole('button', { name: 'ログをCSV出力', exact: true }).click();
    expect((await responded).status()).toBe(400);
    await expect(page.getByRole('alert')).toContainText('入力内容に誤りがあります');
    await expect(page.getByLabel('終了日（任意）')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('終了日は開始日以降の日付を指定してください', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ログをCSV出力', exact: true })).toBeEnabled();
  });

  test('最新10000件へ切り詰めたときだけ、期間を絞る案内を出す', async ({ page }) => {
    let downloads = 0;
    await page.route(EXPORT_ROUTE, (route) => route.fulfill({
      status: 200, contentType: 'text/csv; charset=utf-8', body: `\uFEFF${CSV_HEADER}\r\n`,
      headers: { 'x-truncated': String(downloads++ === 0) },
    }));
    await readDownload(await downloadCsv(page));
    await expect(page.getByRole('status')).toContainText('最新10,000件を出力しました');
    await expect(page.getByRole('status')).toContainText('期間を絞って再度出力してください');
    await readDownload(await downloadCsv(page));
    await expect(page.getByRole('status')).toHaveText('CSVのダウンロードを開始しました。');
  });

  for (const status of [401, 403, 404]) {
    test(`HTMLの${status}でもCSVを保存せず共通画面へ遷移する`, async ({ page }) => {
      let downloads = 0;
      page.on('download', () => downloads++);
      await page.route(EXPORT_ROUTE, (route) => route.fulfill({
        status, contentType: 'text/html', body: '<html><body>Proxy error</body></html>',
      }));
      if (status === 401) await page.context().clearCookies();
      await page.getByRole('button', { name: 'ログをCSV出力', exact: true }).click();
      await page.waitForURL(status === 401 ? /\/login\?next=%2Fsystem$/ : new RegExp(`/error\\?code=${status}$`));
      expect(downloads).toBe(0);
    });
  }

  test('通信断はサマリを出し、入力と再試行を保つ', async ({ page }) => {
    await page.getByLabel('開始日（任意）').fill(EXPORT_DAY);
    await page.route(EXPORT_ROUTE, (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'ログをCSV出力', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(COMMUNICATION_ERROR_MESSAGE);
    await expect(page.getByLabel('開始日（任意）')).toHaveValue(EXPORT_DAY);
    await expect(page.getByRole('button', { name: 'ログをCSV出力', exact: true })).toBeEnabled();
  });

  test('200でもHTML応答をCSVとして保存しない', async ({ page }) => {
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.route(EXPORT_ROUTE, (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: '<html><body>Unexpected page</body></html>',
    }));
    await page.getByRole('button', { name: 'ログをCSV出力', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(COMMUNICATION_ERROR_MESSAGE);
    await expect(page.getByRole('button', { name: 'ログをCSV出力', exact: true })).toBeEnabled();
    expect(downloads).toBe(0);
  });

  test('未ログインとプランナーには実APIがCSVを返さない', async ({ request, browser }) => {
    const anonymous = await request.get(EXPORT_PATH);
    expect(anonymous.status()).toBe(401);
    expect((await anonymous.json()).error.code).toBe('UNAUTHENTICATED');
    const plannerContext = await browser.newContext();
    try {
      const plannerPage = await plannerContext.newPage();
      await loginAsPlanner(plannerPage, planner);
      const forbidden = await plannerContext.request.get(EXPORT_PATH);
      expect(forbidden.status()).toBe(403);
      expect((await forbidden.json()).error.code).toBe('FORBIDDEN');
    } finally {
      await plannerContext.close();
    }
  });
});
