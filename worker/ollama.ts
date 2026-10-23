export async function callOllama(model: string, prompt: string, input: string): Promise<unknown> {
  const endpoint = (process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434').replace(/\/$/, '');
  const apiKey = process.env.OLLAMA_API_KEY;
  const response = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model,
      prompt: `${prompt}\n\n---\n${input}`,
      format: 'json',
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 1024 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama がエラーを返しました: ${response.status}`);
  }
  const body = (await response.json()) as { response?: string };
  if (!body.response) throw new Error('Ollama の応答が空でした');

  try {
    return JSON.parse(body.response);
  } catch {
    throw new Error('Ollama の出力がJSONとして読めませんでした');
  }
}
