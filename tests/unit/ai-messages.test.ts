/**
 * AI補助の利用者向け文言変換（UI改善）の単体テスト。
 *
 * 守りたい性質は2つ。
 *  1. 生の error_message（モデル名・接続先・HTTPステータス等）を画面文言に含めない。
 *  2. 原因の種類ごとに、利用者の次の行動が分かる文言へ寄せる。
 */
import { describe, expect, it } from 'vitest';

import { AI_ERROR_FALLBACK_MESSAGE, defectSummaryText, humanAiError } from '@/lib/ai/aiMessages';

describe('humanAiError', () => {
  it('null・空は既定文言になる', () => {
    expect(humanAiError(null)).toBe(AI_ERROR_FALLBACK_MESSAGE);
    expect(humanAiError(undefined)).toBe(AI_ERROR_FALLBACK_MESSAGE);
    expect(humanAiError('')).toBe(AI_ERROR_FALLBACK_MESSAGE);
  });

  it('接続系の理由はAIサーバーへの接続失敗として伝える', () => {
    const message = humanAiError('Ollama がエラーを返しました: 500');
    expect(message).toContain('接続できなかった');
    // 生の理由（サービス名・ステータス）は含めない
    expect(message).not.toContain('Ollama');
    expect(message).not.toContain('500');
  });

  it('JSON・スキーマ系の理由は読み取れなかったとして伝える', () => {
    const message = humanAiError('Ollama の出力がJSONとして読めませんでした');
    expect(message).toContain('読み取れなかった');
    expect(message).not.toContain('JSON');
  });

  it('プロンプト未設定は管理者への連絡として伝える', () => {
    const message = humanAiError(
      'job_type=classification の有効なプロンプトテンプレートがありません',
    );
    expect(message).toContain('管理者にお知らせください');
    expect(message).not.toContain('job_type');
  });

  it('未知の技術的な理由は既定文言に倒し、生の文字列を漏らさない', () => {
    const raw = 'duplicate key value violates unique constraint "ai_jobs_pkey" (code 23505)';
    const message = humanAiError(raw);
    expect(message).toBe(AI_ERROR_FALLBACK_MESSAGE);
    expect(message).not.toContain('23505');
    expect(message).not.toContain('ai_jobs_pkey');
  });
});

describe('defectSummaryText', () => {
  it('②未実施では合計に含めず未実施と明記する', () => {
    expect(defectSummaryText(3, 0, false)).toBe(
      '3件の指摘があります（ルール 3件 / 要確認 未実施）',
    );
    expect(defectSummaryText(0, 0, false)).toBe('指摘はありません（ルール 0件 / 要確認 未実施）');
  });

  it('②実施済みでは合計件数を先に出す', () => {
    expect(defectSummaryText(2, 1, true)).toBe('3件の指摘があります（ルール 2件 / 要確認 1件）');
    expect(defectSummaryText(0, 0, true)).toBe('指摘はありません（ルール 0件 / 要確認 0件）');
  });
});
