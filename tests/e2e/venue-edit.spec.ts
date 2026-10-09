/** S02 式場編集。専用の模擬式場・アカウントだけを作成し、終了時に削除する。 */
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { adminClient } from './helpers/admin';
import { e2eEnv, hasE2eEnv, uniqueEmail } from './helpers/env';
import { loginAsPlanner } from './helpers/flows';

function canUseFixtureDatabase(): boolean {
  if (!hasE2eEnv) return false;
  try {
    const url = new URL(e2eEnv.supabaseUrl);
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      (url.protocol === 'https:' && process.env.E2E_ALLOW_REMOTE_VENUE_TESTS === '1')
    );
  } catch {
    return false;
  }
}

test.skip(!canUseFixtureDatabase(), 'ローカルSupabase、または明示許可した開発DBの接続情報が必要');

interface VenueAccount {
  authUserId: string;
  profileId: string;
  email: string;
  password: string;
  displayName: string;
}

async function createAccount(
  role: 'system_admin' | 'planner',
  venueId: string,
): Promise<VenueAccount> {
  const email = uniqueEmail(`venue-${role}`);
  const password = `E2e!${randomUUID()}aA9`;
  const displayName = `式場編集 E2E ${role}`;
  // Admin API の createUser は確認メールを送らない。実行ごとにパスワードを変える。
  const created = await adminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`式場編集用Authユーザーの作成失敗: ${created.error?.message}`);
  }
  const authUserId = created.data.user.id;
  try {
    const profile = await adminClient()
      .from('user_profiles')
      .insert({
        auth_user_id: authUserId,
        venue_id: role === 'system_admin' ? null : venueId,
        role,
        email,
        display_name: displayName,
        status: 'active',
      })
      .select('id')
      .single();
    if (profile.error || !profile.data) {
      throw new Error(`式場編集用プロフィールの作成失敗: ${profile.error?.message}`);
    }
    return { authUserId, profileId: profile.data.id, email, password, displayName };
  } catch (error) {
    const removed = await adminClient().auth.admin.deleteUser(authUserId);
    if (removed.error)
      throw new AggregateError([error, removed.error], 'Auth作成失敗時の清掃にも失敗');
    throw error;
  }
}

async function loginAsSystemAdmin(page: Page, account: VenueAccount): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'パスワードでログイン（プランナー・管理者）' }).click();
  await page.getByLabel('メールアドレス').fill(account.email);
  await page.getByLabel('パスワード').fill(account.password);
  await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
  await page.waitForURL(/\/system$/);
  await expect(
    page.getByRole('heading', { name: '利用状況・通知ログ', exact: true }),
  ).toBeVisible();
}

/** 既存の式場件数に依存せず、一覧のページ送りから自分のfixtureを探す。 */
async function findVenueInList(page: Page, code: string): Promise<void> {
  await expect(page.getByRole('heading', { name: '式場一覧', exact: true })).toBeVisible();
  for (let count = 0; count < 100; count++) {
    if (await page.getByRole('link', { name: code, exact: true }).count()) return;
    const next = page.getByRole('link', { name: '次のページ', exact: true });
    await expect(next, '専用の模擬式場が一覧に存在すること').toBeVisible();
    const href = await next.getAttribute('href');
    await next.click();
    await expect(page).toHaveURL(new URL(href!, page.url()).href);
  }
  throw new Error('専用の模擬式場を100ページ以内で見つけられませんでした');
}

test.describe('式場の詳細・変更', () => {
  const venueId = randomUUID();
  const code = `E2${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const original = {
    name: `式場編集の模擬式場 ${code}`,
    contact_email: `${code.toLowerCase()}@e2e.test`,
    active: true,
  };
  const detailPath = `/venues/${venueId}`;
  const apiPath = `/api/venues/${venueId}`;
  let venueCreated = false;
  let systemAdmin: VenueAccount | undefined;
  let planner: VenueAccount | undefined;

  async function cleanFixtures(): Promise<void> {
    const accounts = [systemAdmin, planner].filter((account): account is VenueAccount =>
      Boolean(account),
    );
    const profileIds = accounts.map((account) => account.profileId);
    const failures: string[] = [];
    // audit_logs.actor_user_id は profile 削除を妨げる。fixtureに紐付く行だけを先に削除する。
    if (profileIds.length) {
      const actorLogs = await adminClient()
        .from('audit_logs')
        .delete()
        .in('actor_user_id', profileIds);
      if (actorLogs.error) failures.push(actorLogs.error.message);
    }
    const targetIds = [...profileIds, ...(venueCreated ? [venueId] : [])];
    if (targetIds.length) {
      const targetLogs = await adminClient().from('audit_logs').delete().in('target_id', targetIds);
      if (targetLogs.error) failures.push(targetLogs.error.message);
    }
    for (const account of accounts) {
      const profile = await adminClient()
        .from('user_profiles')
        .delete()
        .eq('id', account.profileId);
      if (profile.error) failures.push(profile.error.message);
      const auth = await adminClient().auth.admin.deleteUser(account.authUserId);
      if (auth.error) failures.push(auth.error.message);
    }
    if (venueCreated) {
      const venue = await adminClient().from('venues').delete().eq('id', venueId);
      if (venue.error) failures.push(venue.error.message);
    }
    if (failures.length) throw new Error(`式場編集fixtureの清掃失敗: ${failures.join('; ')}`);
    systemAdmin = undefined;
    planner = undefined;
    venueCreated = false;
  }

  async function readVenue() {
    const result = await adminClient()
      .from('venues')
      .select('id, name, code, contact_email, active, updated_at')
      .eq('id', venueId)
      .single();
    if (result.error || !result.data) throw new Error('専用の模擬式場を取得できません');
    return result.data;
  }

  async function openDetail(page: Page): Promise<void> {
    await page.goto(detailPath);
    await expect(
      page.getByRole('heading', { name: '式場の詳細・変更', exact: true }),
    ).toBeVisible();
  }

  async function save(page: Page, expectedStatus = 200) {
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === apiPath && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '変更を保存', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(expectedStatus);
    return response;
  }

  test.beforeAll(async () => {
    try {
      const venue = await adminClient()
        .from('venues')
        .insert({ id: venueId, code, ...original });
      if (venue.error) throw new Error(`専用の模擬式場を作成できません: ${venue.error.message}`);
      venueCreated = true;
      systemAdmin = await createAccount('system_admin', venueId);
      planner = await createAccount('planner', venueId);
    } catch (error) {
      try {
        await cleanFixtures();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], '式場編集fixtureの準備と清掃に失敗');
      }
      throw error;
    }
  });

  test.afterAll(cleanFixtures);

  test.beforeEach(async ({ page }) => {
    const reset = await adminClient().from('venues').update(original).eq('id', venueId);
    if (reset.error) throw new Error(`専用の模擬式場を初期化できません: ${reset.error.message}`);
    if (!systemAdmin) throw new Error('管理者fixtureがありません');
    await loginAsSystemAdmin(page, systemAdmin);
  });

  test('未ログインの式場リンクは同じOriginのパスワード画面へ移り、メール送信せず保存できる', async ({
    page,
    baseURL,
  }) => {
    await page.context().clearCookies();
    let otpRequests = 0;
    await page.route('**/api/auth/otp-request', async (route) => {
      otpRequests += 1;
      await route.abort();
    });
    await page.goto(detailPath);
    await expect(page).toHaveURL(
      new URL(`/login?next=${encodeURIComponent(detailPath)}`, baseURL!).href,
    );
    await expect(page.getByLabel('パスワード', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'ログインリンクを送信', exact: true }),
    ).toHaveCount(0);
    await page.getByLabel('メールアドレス').fill(systemAdmin!.email);
    await page.getByLabel('パスワード', { exact: true }).fill(systemAdmin!.password);
    await page.getByRole('button', { name: 'パスワードでログイン', exact: true }).click();
    await expect(page).toHaveURL(new URL(detailPath, baseURL!).href);
    await expect(
      page.getByRole('heading', { name: '式場の詳細・変更', exact: true }),
    ).toBeVisible();
    await save(page);
    await expect(page.getByText('変更を保存しました。', { exact: true })).toBeVisible();
    expect(otpRequests).toBe(0);
  });

  test('利用状況から一覧・詳細へ進み、変更が再読み込みと一覧に残る', async ({ page }) => {
    await page.getByRole('link', { name: '式場一覧', exact: true }).click();
    await findVenueInList(page, code);
    await page.getByRole('link', { name: code, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${detailPath}$`));
    await expect(
      page.getByRole('heading', { name: '式場の詳細・変更', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('式場コード（変更不可）')).toHaveValue(code);
    await expect(page.getByLabel('式場コード（変更不可）')).toHaveJSProperty('readOnly', true);
    const name = `変更した模擬式場 ${code}`;
    const email = `updated-${code.toLowerCase()}@e2e.test`;
    await page.getByLabel('式場名（必須）').fill(`  ${name}  `);
    await page.getByLabel('式場代表メール（任意）').fill(email);
    const response = await save(page);
    expect(await response.json()).toMatchObject({
      id: venueId,
      code,
      name,
      contactEmail: email,
      active: true,
    });
    await expect(page.getByRole('status')).toHaveText('変更を保存しました。');
    await page.reload();
    await expect(page.getByLabel('式場名（必須）')).toHaveValue(name);
    await expect(page.getByLabel('式場代表メール（任意）')).toHaveValue(email);
    await page.getByRole('link', { name: '式場一覧へ戻る', exact: true }).click();
    await findVenueInList(page, code);
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: code, exact: true }) });
    await expect(row).toContainText(name);
    await expect(row).toContainText('利用中');
    expect(await readVenue()).toMatchObject({ code, name, contact_email: email, active: true });
  });

  test('代表メールを空欄にして利用中を外すと、nullと停止中が保存される', async ({ page }) => {
    await openDetail(page);
    await page.getByLabel('式場代表メール（任意）').fill('');
    await page.getByLabel('利用中', { exact: true }).uncheck();
    expect(await (await save(page)).json()).toMatchObject({ contactEmail: null, active: false });
    await expect(page.getByRole('status')).toHaveText('変更を保存しました。');
    await page.reload();
    await expect(page.getByLabel('式場代表メール（任意）')).toHaveValue('');
    await expect(page.getByLabel('利用中', { exact: true })).not.toBeChecked();
    await page.getByRole('link', { name: '式場一覧へ戻る', exact: true }).click();
    await findVenueInList(page, code);
    await expect(
      page.getByRole('row').filter({ has: page.getByRole('link', { name: code, exact: true }) }),
    ).toContainText('停止中');
    expect(await readVenue()).toMatchObject({ contact_email: null, active: false });
  });

  test('空白だけの式場名と不正なメールは項目エラーになり、保存されない', async ({ page }) => {
    await openDetail(page);
    const before = await readVenue();
    await page.getByLabel('式場名（必須）').fill('   ');
    await save(page, 400);
    await expect(page.getByRole('form', { name: '式場の変更' }).getByRole('alert')).toContainText(
      '入力内容に誤りがあります',
    );
    await expect(page.getByLabel('式場名（必須）')).toHaveAttribute('aria-invalid', 'true');
    expect(await readVenue()).toEqual(before);
    await page.getByLabel('式場名（必須）').fill(original.name);
    await page.getByLabel('式場代表メール（任意）').fill('invalid-email');
    await save(page, 400);
    await expect(page.getByLabel('式場代表メール（任意）')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: '変更を保存', exact: true })).toBeEnabled();
    expect(await readVenue()).toEqual(before);
  });

  test('別Origin・Originなしを拒否し、コードや未知の項目も変更しない', async ({ page }) => {
    const before = await readVenue();
    const origin = new URL(page.url()).origin;
    const rejectedOrigins: Record<string, string>[] = [{ origin: 'https://foreign.e2e.test' }, {}];
    for (const headers of rejectedOrigins) {
      const rejected = await page.request.patch(apiPath, {
        headers,
        data: { name: '変更されてはいけない式場' },
      });
      expect(rejected.status()).toBe(403);
      expect((await rejected.json()).error.code).toBe('FORBIDDEN');
    }
    for (const data of [
      { code: 'CHANGED1' },
      { name: '変更されてはいけない式場', unknownField: true },
    ]) {
      const rejected = await page.request.patch(apiPath, { headers: { origin }, data });
      expect(rejected.status()).toBe(400);
      expect((await rejected.json()).error.code).toBe('VALIDATION_ERROR');
    }
    expect(await readVenue()).toEqual(before);
  });

  test('存在しないUUIDと不正なIDはAPIと画面で対象なしになる', async ({ page }) => {
    const before = await readVenue();
    const origin = new URL(page.url()).origin;
    for (const missingId of [randomUUID(), 'not-a-uuid']) {
      const response = await page.request.patch(`/api/venues/${missingId}`, {
        headers: { origin },
        data: { name: '対象なしの模擬式場' },
      });
      expect(response.status()).toBe(404);
      expect((await response.json()).error.code).toBe('NOT_FOUND');
      // App RouterのストリーミングではHTTP状態に依存せず、404画面への切り替えを確認する。
      await page.goto(`/venues/${missingId}`);
      await expect(
        page.getByRole('heading', { name: 'ページが見つかりません', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('form', { name: '式場の変更' })).toHaveCount(0);
    }
    expect(await readVenue()).toEqual(before);
  });

  test('未ログインはAPIが401、プランナーは画面とAPIが403になる', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const before = await readVenue();
    const origin = new URL(page.url()).origin;
    const anonymous = await request.patch(apiPath, {
      headers: { origin },
      data: { name: '権限なし' },
    });
    expect(anonymous.status()).toBe(401);
    expect((await anonymous.json()).error.code).toBe('UNAUTHENTICATED');
    const plannerContext = await browser.newContext({ baseURL });
    try {
      if (!planner) throw new Error('プランナーfixtureがありません');
      const plannerPage = await plannerContext.newPage();
      await loginAsPlanner(plannerPage, planner);
      await plannerPage.goto(detailPath);
      await expect(plannerPage).toHaveURL(/\/error\?code=403$/);
      await expect(
        plannerPage.getByRole('heading', { name: 'このページは表示できません', exact: true }),
      ).toBeVisible();
      await expect(plannerPage.getByRole('form', { name: '式場の変更' })).toHaveCount(0);
      const forbidden = await plannerContext.request.patch(apiPath, {
        headers: { origin },
        data: { name: '権限なし' },
      });
      expect(forbidden.status()).toBe(403);
      expect((await forbidden.json()).error.code).toBe('FORBIDDEN');
    } finally {
      await plannerContext.close();
    }
    expect(await readVenue()).toEqual(before);
  });

  test('保存が一度500で失敗しても入力を残し、再試行で保存できる', async ({ page }) => {
    await openDetail(page);
    const before = await readVenue();
    const name = `再試行した模擬式場 ${code}`;
    await page.getByLabel('式場名（必須）').fill(name);
    await page.route(
      `**${apiPath}`,
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'サーバー側で問題が発生しました',
              details: [],
            },
          }),
        }),
      { times: 1 },
    );
    await save(page, 500);
    await expect(page.getByRole('form', { name: '式場の変更' }).getByRole('alert')).toContainText(
      'サーバー側で問題が発生しました',
    );
    await expect(page.getByLabel('式場名（必須）')).toHaveValue(name);
    await expect(page.getByRole('button', { name: '変更を保存', exact: true })).toBeEnabled();
    expect(await readVenue()).toEqual(before);
    await save(page);
    await expect(page.getByRole('status')).toHaveText('変更を保存しました。');
    await page.reload();
    await expect(page.getByLabel('式場名（必須）')).toHaveValue(name);
    expect(await readVenue()).toMatchObject({ name });
  });
});
