import assert from 'node:assert/strict';

import { validateAiOutput } from '../src/lib/ai/schemas';
import { callOllama } from '../worker/ollama';

const model = process.env.OLLAMA_MODEL ?? 'gemma3:12b';
const result = await callOllama(
  model,
  '結婚式準備の問い合わせを分類してください。JSONのみを出力してください。' +
    '形式は {"labels":["費用"],"confidence":0.9} です。' +
    'labelsは日程、費用、衣装、料理・飲物、装花・装飾、写真・映像、' +
    '招待客・席次、進行・演出、支払い・手続き、その他から選んでください。',
  '結婚式の料理の予算について相談したいです。',
);
const validated = validateAiOutput('classification', result);
assert.ok(validated.ok, '分類結果が業務用JSONスキーマに適合しません');
const labels = (validated.value as { labels: string[] }).labels;
assert.ok(labels.includes('費用') || labels.includes('料理・飲物'), '分類内容が入力と一致しません');
console.log(JSON.stringify({ model, jobType: 'classification', output: validated.value }, null, 2));
console.log('Ollama実機テスト成功（DBへの書き込みなし）');
