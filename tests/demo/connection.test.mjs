import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { diagnose, parseConnectionCode } from '../../scripts/demo-ai.mjs';

test('接続コード: ai-agent-lab の aal:// と local を読める', () => {
  assert.deepEqual(parseConnectionCode('aal://100.64.1.2:8766?model=gemma3:12b&key=k1'), {
    endpoint: 'http://100.64.1.2:8766',
    key: 'k1',
    model: 'gemma3:12b',
    label: 'ai-agent-lab の生成窓口',
  });
  assert.equal(parseConnectionCode(' local ').endpoint, 'http://127.0.0.1:11434');
  assert.equal(parseConnectionCode('local?model=qwen2.5:7b').model, 'qwen2.5:7b');
});

test('接続コード: Tailscale・このPC以外や合言葉なしは拒否する', () => {
  assert.throws(() => parseConnectionCode('aal://192.168.0.5:8766?key=k'), /Tailscale/);
  assert.throws(() => parseConnectionCode('aal://100.64.1.2:8766?model=x'), /形式/);
  assert.throws(() => parseConnectionCode('http://100.64.1.2:8766?key=k'), /形式/);
});

test('疎通確認: 届かない・合言葉違い・モデルなしを1行で言い分ける', async () => {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ok') return res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'gemma3:12b' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await diagnose(endpoint, 'gemma3:12b', { authorization: 'Bearer ok' }), null);
    assert.match(await diagnose(endpoint, 'gemma3:12b', { authorization: 'Bearer ng' }), /合言葉/);
    assert.match(
      await diagnose(endpoint, 'qwen2.5:7b', { authorization: 'Bearer ok' }),
      /モデル qwen2.5:7b がありません/,
    );
  } finally {
    server.close();
  }
  assert.match(await diagnose('http://127.0.0.1:1', 'gemma3:12b', {}), /届きません/);
});
