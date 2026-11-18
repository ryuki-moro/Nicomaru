import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { parseScript } from '../../scripts/demo-script.mjs';

test('発表台本.md: 発表者の画面が使う節（導入〜締め）と各幕の操作・セリフが読める', async () => {
  const sections = parseScript(await readFile('docs/発表/AIデモ/発表台本.md', 'utf8'));
  for (const key of ['導入', '第1幕', '第2幕', '第3幕', '締め']) assert.ok(sections[key], key);
  for (const key of ['第1幕', '第2幕', '第3幕']) {
    assert.match(sections[key].op, /AIに|記録して案を作る/);
    assert.ok(sections[key].items.some((item) => item.type === 'say'));
    assert.ok(sections[key].items.some((item) => item.type === 'cue'));
  }
});

test('台本の読み取り: 見出し以外の節（困ったとき）は混ぜない', () => {
  const sections = parseScript('### 導入（0:00）\n> こんにちは\n## 困ったとき\n> 混ぜない\n');
  assert.deepEqual(sections['導入'].items, [{ type: 'say', text: 'こんにちは' }]);
});
