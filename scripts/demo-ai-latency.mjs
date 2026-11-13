// AIデモの待ち時間を測る（#240）。npm run demo:all を起動した状態で:
//   node scripts/demo-ai-latency.mjs [回数=5]
// 台本の4つのAI操作それぞれで、ボタンを押してから結果（採用ボタン）が出るまでの秒数を測り、中央値を出す。
import { readFile } from 'node:fs/promises';

import { chromium } from '@playwright/test';

const runs = Number(process.argv[2] ?? 5);
const { scenes } = JSON.parse(await readFile('.wrangler/demo/credentials.json', 'utf8'));
const open = (path) => `http://p.demo.localhost:3106/__demo/login?next=${encodeURIComponent(path)}`;
const TIMEOUT = 120_000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const button = (name) => page.getByRole('button', { name, exact: true });
const sibling = (name) => button(name).locator('xpath=following-sibling::button[1]');

async function measure(click, done) {
  const start = performance.now();
  await click();
  await done.waitFor({ state: 'visible', timeout: TIMEOUT });
  return (performance.now() - start) / 1000;
}
/** 前の結果が残っていれば破棄して、依頼できる状態に戻す */
async function discardIfShown(adoptName) {
  if (await button(adoptName).isVisible()) {
    await sibling(adoptName).click();
    await button(adoptName).waitFor({ state: 'hidden' });
  }
}

const results = { 宿題の起票: [], 不備チェック: [], 差し戻し文: [], 翻訳: [] };
for (let i = 0; i < runs; i++) {
  await page.goto(open(scenes.meeting));
  await discardIfShown('起票案を採用する');
  await page.goto(open(scenes.meeting));
  results.宿題の起票.push(
    await measure(() => button('記録して案を作る').click(), button('起票案を採用する')),
  );

  await page.goto(open(scenes.guests));
  await discardIfShown('下書きを採用する');
  await discardIfShown('このチェックを採用する');
  results.不備チェック.push(
    await measure(
      () => button('AIに表記ゆれ・敬称を見てもらう').click(),
      button('このチェックを採用する'),
    ),
  );
  await page.getByRole('radio', { name: '不備あり' }).check();
  results.差し戻し文.push(
    await measure(() => button('AIに文面の下書きを頼む').click(), button('下書きを採用する')),
  );

  await page.goto(open(scenes.bgm));
  await page
    .locator('select', { has: page.locator('option', { hasText: '日本語' }) })
    .selectOption({ label: '日本語' });
  results.翻訳.push(
    await measure(() => button('AIに翻訳を頼む').click(), button('コメント欄に入れる')),
  );
  console.log(
    `${i + 1}/${runs} 回目`,
    Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.at(-1).toFixed(1)])),
  );
}
await browser.close();

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
console.log('\n| 操作 | 中央値（秒） | 各回（秒） |\n| --- | --- | --- |');
for (const [name, values] of Object.entries(results))
  console.log(
    `| ${name} | ${median(values).toFixed(1)} | ${values.map((v) => v.toFixed(1)).join(' / ')} |`,
  );
