/**
 * QA-06: ローカルSupabaseだけで300案件・30利用者の初回表示を実測する。
 * 実行例: E2E_RUN_PERFORMANCE=1 npx playwright test performance-load --project=chromium
 * 共有DBには接続せず、実行専用IDのfixtureだけをfinallyで消す。
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { createServerClient } from '@supabase/ssr';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { encryptPii } from '../../src/lib/crypto';
import { adminClient } from './helpers/admin';
import { e2eEnv, futureDate, hasE2eEnv, uniqueEmail } from './helpers/env';
import { FIRST_SCREEN_MARK, installFirstScreenMark } from './helpers/first-screen-mark';

function local(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

const appUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const enabled =
  process.env.E2E_RUN_PERFORMANCE === '1' &&
  hasE2eEnv &&
  local(e2eEnv.supabaseUrl) &&
  local(appUrl);

interface Account {
  profileId: string;
  authUserId: string;
  role: 'planner' | 'couple';
  venueId: string;
  email: string;
  password: string;
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (percent: number) =>
    Math.round(sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)]);
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
    over3Seconds: sorted.filter((value) => value > 3000).length,
  };
}

test('300案件・30同時利用者で初回表示と一覧取得を測定する', async ({ browser }, testInfo) => {
  test.skip(
    !enabled,
    'E2E_RUN_PERFORMANCE=1 とローカル専用Supabase/アプリが必要（共有環境へ負荷をかけない）',
  );
  test.skip(testInfo.project.name !== 'chromium', '負荷測定はDesktop Chromiumで一度だけ実行');
  test.setTimeout(240_000);
  const admin = adminClient();
  const venueIds = Array.from({ length: 3 }, () => randomUUID());
  const caseIds: string[] = [];
  const accounts: Account[] = [];
  const authUserIds: string[] = [];
  const contexts: BrowserContext[] = [];
  const pages: { page: Page; account: Account }[] = [];
  const operation = async (
    query: PromiseLike<{ error: { message: string } | null }>,
    label: string,
  ) => {
    const result = await query;
    if (result.error) throw new Error('性能fixture: ' + label + 'に失敗');
  };

  try {
    await operation(
      admin.from('venues').insert(
        venueIds.map((id, index) => ({
          id,
          name: '性能測定専用式場 ' + index,
          code: 'PF' + id.replaceAll('-', '').slice(0, 8).toUpperCase(),
        })),
      ),
      '式場作成',
    );

    for (const venueId of venueIds) {
      for (let index = 0; index < 10; index++) {
        const role = index < 5 ? 'planner' : 'couple';
        const email = uniqueEmail('performance-' + role);
        const password = 'Perf!' + randomUUID() + 'Aa9';
        const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (created.error || !created.data.user) throw new Error('性能fixture: Auth作成に失敗');
        authUserIds.push(created.data.user.id);
        const profileId = randomUUID();
        await operation(
          admin.from('user_profiles').insert({
            id: profileId,
            auth_user_id: created.data.user.id,
            venue_id: venueId,
            role,
            email,
            display_name: '性能測定利用者',
            status: 'active',
          }),
          'プロフィール作成',
        );
        accounts.push({
          profileId,
          authUserId: created.data.user.id,
          role,
          venueId,
          email,
          password,
        });
      }
      const planners = accounts.filter(
        (account) => account.venueId === venueId && account.role === 'planner',
      );
      const couples = accounts.filter(
        (account) => account.venueId === venueId && account.role === 'couple',
      );
      const cases = Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        venue_id: venueId,
        primary_planner_id: planners[index % planners.length].profileId,
        case_code: 'PF-' + String(index + 1).padStart(3, '0'),
        wedding_date: futureDate(120 + index),
        status: 'active',
        guest_count: 40,
      }));
      caseIds.push(...cases.map((item) => item.id));
      await operation(admin.from('wedding_cases').insert(cases), '案件作成');
      await operation(
        admin.from('couple_profiles').insert(
          cases.flatMap((item, index) => [
            {
              case_id: item.id,
              partner_role: 'groom',
              full_name: encryptPii('模擬新郎'),
              is_primary_contact: true,
              user_profile_id: couples[index]?.profileId ?? null,
            },
            {
              case_id: item.id,
              partner_role: 'bride',
              full_name: encryptPii('模擬新婦'),
              is_primary_contact: false,
            },
          ]),
        ),
        'カップル作成',
      );
      await operation(
        admin.from('case_tasks').insert(
          cases.flatMap((item) =>
            Array.from({ length: 8 }, (_, index) => ({
              case_id: item.id,
              title: '性能測定用宿題 ' + index,
              submission_format: 'text',
              due_date: futureDate(30 + index),
              display_order: index,
              status: 'not_started',
              importance: 'normal',
            })),
          ),
        ),
        '宿題作成',
      );
      await operation(
        admin.from('risk_score_snapshots').insert(
          cases.map((item, index) => ({
            case_id: item.id,
            score_value: index % 3 === 0 ? 75 : 10,
            score_level: index % 3 === 0 ? 'high' : 'low',
            reasons: [],
            is_current: true,
          })),
        ),
        'リスク作成',
      );
    }

    const counted = await admin
      .from('wedding_cases')
      .select('id', { count: 'exact', head: true })
      .in('venue_id', venueIds);
    expect(counted.error).toBeNull();
    expect(counted.count).toBe(300);
    // ログインは計測前に済ませる。30人は別のcookieコンテキストを持つ。
    for (const account of accounts) {
      const jar = new Map<string, string>();
      const sessionClient = createServerClient(e2eEnv.supabaseUrl, e2eEnv.anonKey, {
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (cookies) => {
            for (const cookie of cookies) jar.set(cookie.name, cookie.value);
          },
        },
      });
      const signed = await sessionClient.auth.signInWithPassword({
        email: account.email,
        password: account.password,
      });
      if (signed.error) throw new Error('性能fixture: ログインに失敗');
      const context = await browser.newContext({
        baseURL: appUrl,
        serviceWorkers: 'block',
        locale: 'ja-JP',
      });
      contexts.push(context);
      await context.addInitScript(installFirstScreenMark, {
        pathname: account.role === 'planner' ? '/dashboard' : '/mypage',
        heading: account.role === 'planner' ? 'ダッシュボード' : '次にやること',
        markName: FIRST_SCREEN_MARK,
        timeoutMs: 30_000,
      });
      await context.addCookies(
        [...jar].map(([name, value]) => ({ name, value, url: new URL(appUrl).origin })),
      );
      pages.push({ page: await context.newPage(), account });
    }

    const firstScreens = await Promise.all(
      pages.map(async ({ page, account }) => {
        const path = account.role === 'planner' ? '/dashboard' : '/mypage';
        const started = performance.now();
        const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
        expect(response?.status()).toBe(200);
        await expect(
          page.getByRole('heading', {
            name: account.role === 'planner' ? 'ダッシュボード' : '次にやること',
            exact: true,
          }),
        ).toBeVisible();
        await page.waitForFunction(
          (markName) => performance.getEntriesByName(markName, 'mark').length === 1,
          FIRST_SCREEN_MARK,
          { timeout: 30_000 },
        );
        const timing = await page.evaluate((markName) => {
          const navigation = performance.getEntriesByType(
            'navigation',
          )[0] as PerformanceNavigationTiming;
          return {
            firstScreenMs: performance.getEntriesByName(markName, 'mark')[0].startTime,
            responseEndMs: navigation.responseEnd,
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
          };
        }, FIRST_SCREEN_MARK);
        return { screen: path, elapsedMs: performance.now() - started, ...timing };
      }),
    );

    const lists = await Promise.all(
      pages
        .filter(({ account }) => account.role === 'planner')
        .map(async ({ page }) => {
          const started = performance.now();
          const response = await page.request.get('/api/cases?offset=0&limit=20');
          expect(response.status()).toBe(200);
          await response.body();
          return performance.now() - started;
        }),
    );
    const report = {
      measuredAt: new Date().toISOString(),
      environment: 'local-supabase',
      browser: 'chromium',
      dataset: {
        venues: 3,
        cases: 300,
        tasks: 2400,
        concurrentUsers: 30,
        plannerUsers: 15,
        coupleUsers: 15,
      },
      thresholdMs: 3000,
      dashboard: summary(
        firstScreens.filter((row) => row.screen === '/dashboard').map((row) => row.firstScreenMs),
      ),
      mypage: summary(
        firstScreens.filter((row) => row.screen === '/mypage').map((row) => row.firstScreenMs),
      ),
      caseList: summary(lists),
      samples: firstScreens,
      interpretation:
        '認証を済ませた空キャッシュの30ブラウザによる初回表示。firstScreenMsはブラウザ内で対象見出しの表示を連続する描画フレームで確認したmarkの時刻で、LCPや操作準備完了ではない。elapsedMsはPlaywrightの確認・通信待ちも含む上限時間。ブラウザCPUとSSR/DBは同じ実行環境を共有する。監視/日次集計の併走、商用SLA、実端末性能は測定していない。',
    };
    const filename = testInfo.outputPath('performance-300cases-30users.json');
    await writeFile(filename, JSON.stringify(report, null, 2));
    await testInfo.attach('performance-300cases-30users', {
      path: filename,
      contentType: 'application/json',
    });
    console.info(
      JSON.stringify({
        event: 'performance_test_summary',
        dashboard: report.dashboard,
        mypage: report.mypage,
        caseList: report.caseList,
      }),
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    // 部分的なfixture作成失敗でも、記録済みの専用IDだけを順番に清掃する。
    const failures: string[] = [];
    const clean = async (
      query: PromiseLike<{ error: { message: string } | null }>,
      label: string,
    ) => {
      const result = await query;
      if (result.error) failures.push(label);
    };
    if (caseIds.length)
      await clean(admin.from('wedding_cases').delete().in('id', caseIds), 'cases');
    const profileIds = accounts.map((account) => account.profileId);
    if (profileIds.length) {
      await clean(admin.from('audit_logs').delete().in('actor_user_id', profileIds), 'audit_logs');
      await clean(admin.from('user_profiles').delete().in('id', profileIds), 'profiles');
    }
    for (const id of authUserIds) {
      const result = await admin.auth.admin.deleteUser(id);
      if (result.error) failures.push('auth');
    }
    await clean(admin.from('venues').delete().in('id', venueIds), 'venues');
    if (failures.length) throw new Error('性能fixtureの清掃失敗: ' + failures.join(', '));
  }
});
