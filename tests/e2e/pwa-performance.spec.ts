import { expect, test } from '@playwright/test';

test('ホーム画面用manifestとアイコンを未ログインで取得できる', async ({ page, request }) => {
  await page.goto('/login');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/icons/apple-touch-icon.png',
  );
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({ id: '/', scope: '/', start_url: '/', display: 'standalone' });
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
  }
  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toContain('javascript');
  expect(sw.headers()['cache-control']).toContain('no-store');
});

test('SWを登録しても画面/APIをCacheStorageに残さずオフライン再利用しない', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/login');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const registration = await page.evaluate(async () => {
    const worker = await navigator.serviceWorker.getRegistration('/');
    return { script: worker?.active?.scriptURL, caches: await caches.keys() };
  });
  expect(registration.script).toContain('/sw.js');
  expect(registration.caches).toEqual([]);
  const response = await request.get('/api/venues');
  expect(response.status()).toBe(401);
  expect(response.headers()['cache-control']).toContain('no-store');
  await context.setOffline(true);
  try {
    const result = await page.evaluate(async () => {
      for (const url of ['/login?offline-check=1', '/api/venues?offline-check=1']) {
        try {
          await fetch(url, { cache: 'no-store' });
          return 'unexpected cached response';
        } catch {
          /* ネットワークの失敗が期待結果 */
        }
      }
      return 'network unavailable';
    });
    expect(result).toBe('network unavailable');
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});

test('画面性能ログにquery/トークンを含めず表示時間を取得できる', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'info') messages.push(message.text());
  });
  await page.goto('/login?performance_probe=private-query-token');
  await expect
    .poll(() => messages.filter((entry) => entry.includes('screen_performance')).length)
    .toBeGreaterThan(0);
  const records = messages
    .filter((entry) => entry.includes('screen_performance'))
    .map((entry) => JSON.parse(entry));
  expect(records.every((entry) => entry.route === '/login')).toBe(true);
  expect(records.every((entry) => Number.isFinite(entry.value) && entry.value >= 0)).toBe(true);
  expect(JSON.stringify(records)).not.toContain('private-query-token');
});
