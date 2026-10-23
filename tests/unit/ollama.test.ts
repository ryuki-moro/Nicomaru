import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOllama } from '../../worker/ollama';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Ollama client', () => {
  it('設定したAPIへJSON生成を依頼し、本文を解析する', async () => {
    vi.stubEnv('OLLAMA_ENDPOINT', 'http://ollama.test:11434/');
    vi.stubEnv('OLLAMA_API_KEY', 'test-only-key');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ response: '{"labels":["費用"],"confidence":0.9}' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callOllama('pi-default', '分類する', '予算')).resolves.toEqual({
      labels: ['費用'],
      confidence: 0.9,
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama.test:11434/api/generate');
    expect(options.headers.authorization).toBe('Bearer test-only-key');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body)).toMatchObject({
      model: 'pi-default',
      prompt: '分類する\n\n---\n予算',
      format: 'json',
      stream: false,
      think: false,
    });
  });

  it.each([
    [Response.json({}, { status: 503 }), 'Ollama がエラーを返しました: 503'],
    [Response.json({ response: '' }), 'Ollama の応答が空でした'],
    [Response.json({ response: 'not json' }), 'Ollama の出力がJSONとして読めませんでした'],
  ])('失敗応答をジョブのエラー処理へ渡す', async (response, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(callOllama('pi-default', '分類する', '予算')).rejects.toThrow(message);
  });

  it('通信断を成功として扱わない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(callOllama('pi-default', '分類する', '予算')).rejects.toThrow('fetch failed');
  });
});
