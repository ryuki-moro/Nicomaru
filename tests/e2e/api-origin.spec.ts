/**
 * 更新APIのOrigin検証。実サーバーへ送るが、認証情報・有効な入力は渡さない。
 * cases/uploadは未認証、otp-requestは必須メール欠落で止まり、DB・Storage・メールを更新しない。
 */
import { expect, test } from '@playwright/test';

const hasAuthEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
const protectedPaths = ['/api/cases', '/api/auth/otp-request', '/api/files/upload'] as const;

// 他のE2E用ログイン状態を設定されても、このファイルでは利用しない。
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(!hasAuthEnv, 'Supabaseの公開接続設定がないため未認証APIの確認をスキップ');

test('ブラウザーのJSON・multipart POSTはOriginを自動送信し、既存の入力・認証検証へ進む', async ({
  page,
}) => {
  await page.goto('/login');
  const expectedOrigin = new URL(page.url()).origin;
  const cases = [
    { path: '/api/cases', multipart: false, status: 401, code: 'UNAUTHENTICATED' },
    { path: '/api/auth/otp-request', multipart: false, status: 400, code: 'VALIDATION_ERROR' },
    { path: '/api/files/upload', multipart: true, status: 401, code: 'UNAUTHENTICATED' },
  ];

  for (const item of cases) {
    const outgoingPromise = page.waitForRequest(
      (request) => new URL(request.url()).pathname === item.path && request.method() === 'POST',
    );
    const response = await page.evaluate(async ({ path, multipart }) => {
      // Originは設定しない。通常のブラウザーfetchが付ける値をサーバーで検証する。
      const result = await fetch(path, {
        method: 'POST',
        credentials: 'omit',
        headers: multipart ? undefined : { 'content-type': 'application/json' },
        body: multipart ? new FormData() : '{}',
      });
      return { status: result.status, body: await result.json() };
    }, item);
    const outgoing = await outgoingPromise;

    expect(await outgoing.headerValue('origin')).toBe(expectedOrigin);
    expect(await outgoing.headerValue('cookie')).toBeNull();
    expect(await outgoing.headerValue('content-type')).toMatch(
      item.multipart ? /^multipart\/form-data; boundary=/ : /^application\/json/,
    );
    expect(response.status, item.path).toBe(item.status);
    expect(response.body, item.path).toMatchObject({ error: { code: item.code } });
  }
});

for (const origin of [undefined, 'https://foreign-origin.example.invalid']) {
  test(`${origin ? '別Origin' : 'Origin欠落'}の更新APIは認証・入力検証より先に403`, async ({
    page,
  }) => {
    for (const path of protectedPaths) {
      const response = await page.request.post(path, {
        // APIRequestContextはブラウザー外なので、Originの欠落も再現できる。
        headers: origin ? { origin } : {},
        data: {},
      });
      expect(response.status(), path).toBe(403);
      expect(await response.json(), path).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });
}

test('内部cronはOriginなしでも共有secretの認証へ進み、欠落secretを401で拒否する', async ({
  page,
}) => {
  // secretは一切付けない。削除・送信を含むバッチ本体は実行しない。
  const response = await page.request.post('/api/internal/rate-limit-cleanup', { data: {} });
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
});

test('LINE WebhookはOriginなしでも署名検証へ進み、欠落署名を401で拒否する', async ({ page }) => {
  // 空イベントを署名なしで送る。LINEへの返信やDB処理には到達しない。
  const response = await page.request.post('/api/line/webhook', { data: { events: [] } });
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
});
