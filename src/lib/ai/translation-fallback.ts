/**
 * 翻訳補助（9-11）の辞書フォールバック。
 *
 * 正本: 基本設計書 7-5「翻訳」。LLM ワーカーが居ない・ジョブが failed の環境でも
 * デモで翻訳補助の導線を見せられるよう、式場の定型表現だけを辞書で訳す縮退実装。
 * 辞書で訳せなかった文は原文のまま残し、cautions で必ず知らせる（黙って訳文に見せない）。
 *
 * 出力は translationOutputSchema（schemas.ts）で検証してから返す。
 */
import { translationOutputSchema, type AiOutput } from '@/lib/ai/schemas';

export type TranslationOutput = AiOutput<'translation'>;

/** 日→英の定型表現。文単位で照合する（部分置換で文意が壊れるのを避ける）。 */
const JA_TO_EN: readonly (readonly [string, string])[] = [
  ['お世話になっております。', 'Thank you for your continued support.'],
  ['いつもお世話になっております。', 'Thank you, as always, for your continued support.'],
  ['ご確認いただきありがとうございます。', 'Thank you for checking this.'],
  ['ご提出いただきありがとうございます。', 'Thank you for your submission.'],
  ['ご記入いただきありがとうございます。', 'Thank you for filling this in.'],
  ['内容を確認いたしました。', 'We have reviewed the contents.'],
  [
    '恐れ入りますが、ご確認をお願いいたします。',
    'We are sorry to trouble you, but please could you check this.',
  ],
  [
    'お手数をおかけしますが、よろしくお願いいたします。',
    'We apologise for the inconvenience, and thank you for your understanding.',
  ],
  [
    'ご都合がつかない場合はご相談ください。',
    'If the timing does not work for you, please let us know and we can discuss alternatives.',
  ],
  ['期限の調整も可能です。', 'The deadline can be adjusted if needed.'],
  [
    'ご不明な点がございましたらお気軽にお問い合わせください。',
    'If anything is unclear, please feel free to contact us.',
  ],
  ['引き続きよろしくお願いいたします。', 'We look forward to working with you.'],
  ['当日はよろしくお願いいたします。', 'We look forward to seeing you on the day.'],
  [
    'お忙しいところ恐縮ですが、ご対応をお願いいたします。',
    'We appreciate you taking the time, and ask for your help with this.',
  ],
];

const EN_TO_JA: readonly (readonly [string, string])[] = JA_TO_EN.map(
  ([ja, en]) => [en, ja] as const,
);

/** 文の区切り。日本語の句点と英語のピリオドを行単位で扱う。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface DictionaryTranslation {
  output: TranslationOutput;
  /** 辞書で訳せた文の数 / 全文数。デモ表示で「辞書で訳せた範囲」を出すために使う */
  matched: number;
  total: number;
}

/**
 * 辞書だけで翻訳する。target は 'en' | 'ja'。
 * 1文も辞書に無い場合は text を原文のまま返し、cautions で未訳であることを明示する。
 */
export function translateWithDictionary(text: string, target: 'en' | 'ja'): DictionaryTranslation {
  const dict = new Map(target === 'en' ? JA_TO_EN : EN_TO_JA);
  const sentences = splitSentences(text);
  const cautions: string[] = [];
  let matched = 0;
  const translated = sentences.map((sentence) => {
    const hit = dict.get(sentence);
    if (hit) {
      matched += 1;
      return hit;
    }
    return sentence;
  });
  if (matched === 0) {
    cautions.push('辞書に一致する定型文がなかったため、原文のまま表示しています');
  } else if (matched < sentences.length) {
    cautions.push('辞書で訳せなかった文は原文のまま残しています。内容をご確認ください');
  }
  cautions.push('これは定型表現の辞書による簡易翻訳です。送信前に内容をご確認ください');
  const output = translationOutputSchema.parse({
    text: translated.join(target === 'en' ? ' ' : ''),
    language: target,
    cautions,
  });
  return { output, matched, total: sentences.length };
}

/** 対応言語。画面の選択肢と揃える。 */
export const TRANSLATION_TARGETS = [
  { value: 'en', label: '英語' },
  { value: 'ja', label: '日本語' },
] as const;
