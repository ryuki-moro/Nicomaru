import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createDemoServer } from '../../scripts/demo-server.mjs';
import { STORAGE_KEY, seedData, shiftDate, todayJst } from '../../demo/data.mjs';

let browser; let server; let origin;
const output = new URL('../../test-results/demo/', import.meta.url);
const errors = []; const externalRequests = [];

before(async () => {
  server = createDemoServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome' });
  await mkdir(output, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(errors, [], '画面内のJavaScriptエラー');
  assert.deepEqual(externalRequests, [], '外部サービスへの通信');
});

async function open(path = '', options = {}, init = null) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP', ...options });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin + '/')) externalRequests.push(request.url()); });
  await page.goto(`${origin}/${path}`);
  return { context, page };
}
const taskCard = (page, name) => page.locator('article.task-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(sizes.actual <= sizes.viewport, `横方向のはみ出し: ${JSON.stringify(sizes)}`);
}

test('opens without credentials, searches cases, and displays dashboard', async () => {
  const { context, page } = await open();
  try {
    await page.getByRole('heading', { name: 'ダッシュボード', exact: true }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL('dashboard.png', output)), fullPage: true });
    await page.getByRole('link', { name: '案件一覧', exact: true }).click();
    await page.getByLabel('名前・案件番号で検索').fill('見つからない案件');
    await page.getByRole('heading', { name: '該当する案件はありません' }).waitFor();
    await page.getByLabel('名前・案件番号で検索').fill('青木');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('link', { name: '青木 翔太・青木 美咲', exact: true }).click();
    await page.getByRole('heading', { name: '青木 翔太・青木 美咲', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/');
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'main-content');
    await page.getByRole('heading', { name: '青木 翔太・青木 美咲', exact: true }).waitFor();
  } finally { await context.close(); }
});

test('couple submission, planner correction, resubmission, confirmation and reload all work', async () => {
  const { context, page } = await open('#tasks/demo-01');
  try {
    await taskCard(page, 'ゲストリスト提出').getByRole('button', { name: '回答して提出' }).click();
    await page.getByLabel('回答', { exact: true }).fill('ご家族10名、ご友人8名です。');
    await page.getByRole('button', { name: 'デモ内で提出', exact: true }).click();
    await taskCard(page, 'ゲストリスト提出').getByText('提出済', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'プランナー', exact: true }).click();
    await taskCard(page, 'ゲストリスト提出').getByRole('button', { name: '修正をお願いする' }).click();
    await page.getByLabel('修正してほしい内容').fill('お子様の人数を教えてください。');
    await page.getByRole('dialog').getByRole('button', { name: '修正をお願いする' }).click();
    await taskCard(page, 'ゲストリスト提出').getByText('不備あり', { exact: true }).waitFor();
    await page.goto(`${origin}/#tasks/demo-01`);
    await taskCard(page, 'ゲストリスト提出').getByText('お子様の人数を教えてください。', { exact: true }).waitFor();
    await taskCard(page, 'ゲストリスト提出').getByRole('button', { name: '修正して提出' }).click();
    await page.getByLabel('回答', { exact: true }).fill('合計18名、うちお子様は2名です。');
    await page.getByRole('button', { name: 'デモ内で提出', exact: true }).click();
    await page.getByRole('button', { name: 'プランナー', exact: true }).click();
    await taskCard(page, 'ゲストリスト提出').getByRole('button', { name: '確認済にする' }).click();
    await page.reload();
    await taskCard(page, 'ゲストリスト提出').getByText('確認済', { exact: true }).waitFor();
    assert.equal(await taskCard(page, 'ゲストリスト提出').getByText('合計18名、うちお子様は2名です。', { exact: true }).count(), 1);
  } finally { await context.close(); }
});

test('invalid answers stay in dialog and names with markup display only as text', async () => {
  const { context, page } = await open('#tasks/demo-01');
  try {
    await taskCard(page, 'ゲストリスト提出').getByRole('button', { name: '回答して提出' }).click();
    await page.getByLabel('回答', { exact: true }).fill('   ');
    await page.getByRole('button', { name: 'デモ内で提出', exact: true }).click();
    await page.getByRole('alert').getByText('回答を1〜2000文字で入力してください。').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.goto(`${origin}/#dashboard`);
    await page.getByRole('button', { name: '案件を登録', exact: true }).click();
    await page.getByLabel('新郎のお名前').fill('<img src=x onerror=alert(1)>');
    await page.getByLabel('新婦のお名前').fill('サンプル 新婦');
    await page.getByLabel('挙式日', { exact: true }).fill(shiftDate(todayJst(), 100));
    await page.getByRole('dialog').getByRole('button', { name: '案件を登録', exact: true }).click();
    await page.getByRole('heading', { name: '<img src=x onerror=alert(1)>・サンプル 新婦', exact: true }).waitFor();
    assert.equal(await page.locator('#app img').count(), 0);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    assert.equal(stored.cases.length, 6);
    await page.getByRole('button', { name: '案件情報を変更' }).click();
    await page.getByLabel('ゲスト数').fill('35');
    await page.getByRole('button', { name: '変更を保存', exact: true }).click();
    await page.getByText('35名', { exact: true }).waitFor();
  } finally { await context.close(); }
});

test('broken storage recovers and unavailable storage retains changes during the session', async () => {
  const first = await open('', {}, () => { localStorage.setItem('nicomaru-login-free-demo-v1', '{broken'); });
  try {
    await first.page.getByRole('heading', { name: 'ダッシュボード', exact: true }).waitFor();
    await first.page.getByRole('status').getByText('保存データを読み込めなかったため、最初のデモデータを表示しています。').waitFor();
  } finally { await first.context.close(); }
  const second = await open('#tasks/demo-01', {}, () => { Storage.prototype.setItem = () => { throw new Error('test-only storage unavailable'); }; });
  try {
    await taskCard(second.page, 'ゲストリスト提出').getByRole('button', { name: '回答して提出' }).click();
    await second.page.getByLabel('回答', { exact: true }).fill('架空の回答');
    await second.page.getByRole('button', { name: 'デモ内で提出', exact: true }).click();
    await taskCard(second.page, 'ゲストリスト提出').getByText('提出済', { exact: true }).waitFor();
    await second.page.getByRole('status').getByText('ブラウザに保存できませんでした。この画面を開いている間は操作を続けられます。').waitFor();
  } finally { await second.context.close(); }
});

test('mobile screens and dialog fit narrow viewports, and reset returns to five sample cases', async () => {
  const { context, page } = await open('', { viewport: { width: 375, height: 812 } });
  try {
    for (const hash of ['dashboard', 'cases', 'case/demo-01', 'mypage/demo-01', 'tasks/demo-01', 'timeline/demo-01', 'prep/demo-01']) {
      await page.goto(`${origin}/#${hash}`);
      await noOverflow(page);
    }
    await page.goto(`${origin}/#tasks/demo-01`);
    await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: fileURLToPath(new URL('couple-mobile.png', output)), fullPage: true });
    await taskCard(page, 'ゲストリスト提出').getByRole('button', { name: '回答して提出' }).click();
    await noOverflow(page);
    await page.keyboard.press('Escape');
    await page.getByLabel('表示するカップル').selectOption('demo-02');
    await page.getByRole('heading', { name: '宿題', exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '#tasks/demo-02');
    await taskCard(page, 'BGMリクエスト').getByText('不備あり', { exact: true }).waitFor();
    await page.setViewportSize({ width: 320, height: 812 });
    await noOverflow(page);
    const changed = seedData(); changed.cases[0].notes = 'テストの変更';
    await page.evaluate(({ key, data }) => localStorage.setItem(key, JSON.stringify(data)), { key: STORAGE_KEY, data: changed });
    await page.reload();
    await page.getByRole('button', { name: 'デモを初期化', exact: true }).click();
    await page.getByRole('button', { name: '初期化する', exact: true }).click();
    await page.getByRole('heading', { name: 'ダッシュボード', exact: true }).waitFor();
    const reset = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    assert.equal(reset.cases.length, 5);
    assert.notEqual(reset.cases[0].notes, 'テストの変更');
  } finally { await context.close(); }
});
