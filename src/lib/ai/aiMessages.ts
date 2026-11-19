/**
 * AI補助の利用者向け文言（Phase 3、UI改善）。
 *
 * ワーカーが ai_jobs.error_message に残すのは運用向けの技術的な理由で、
 * そのまま画面に出すと利用者には意味が伝わらず、内部構成（モデル名や
 * 接続先）まで漏れる。ここで「利用者が次に何をすればよいか」が分かる
 * 文言へ変換するのがこのモジュールの役割。変換は純関数にして単体テストで固定する。
 *
 * 依頼中・タイムアウトの文言もここを単一ソースにする。
 * 以前はパネルごとに文言が分かれ、「開き直すと表示されます」と
 * 5秒ポーリングの実態と食い違う案内が混在していた。
 */

/** 依頼中（queued / processing）の統一文言。useAiJob の自動更新（5秒ポーリング）が前提。 */
export const AI_PENDING_MESSAGE =
  'AIが作成しています。この画面を開いたままお待ちください。結果は自動で表示されます。';

/** ポーリング打ち切り時（タイムアウト）の統一文言。パネルごとに作らない。 */
export const AI_TIMEOUT_MESSAGE =
  '時間がかかっています。処理は続いているので、このまま少し待つか、しばらくしてから画面を開き直してください。';

/** 採用済みの墓標文言。 */
export const AI_ADOPTED_MESSAGE = '採用しました。この内容で確定しています。';

/** 破棄済みの墓標文言。 */
export const AI_DISCARDED_MESSAGE = 'このAIの結果は破棄しました。必要ならもう一度依頼できます。';

interface ErrorRule {
  pattern: RegExp;
  message: string;
}

/**
 * 技術的な失敗理由 → 利用者向け文言の対応表。
 * 上から順に照合する。具体的な原因ほど上に置く。
 */
const ERROR_RULES: ErrorRule[] = [
  {
    pattern: /timeout|timed out|時間切れ|タイムアウト/i,
    message: 'AIの処理に時間がかかりすぎたため、完了できませんでした。',
  },
  {
    pattern: /プロンプト|prompt|template|テンプレート/i,
    message: 'AIの設定に問題があり、処理できませんでした。管理者にお知らせください。',
  },
  {
    pattern: /model|モデル/i,
    message: 'AIの準備ができていないため、処理できませんでした。管理者にお知らせください。',
  },
  {
    pattern: /json|スキーマ|schema|形式|parse/i,
    message: 'AIの結果を読み取れなかったため、表示できませんでした。',
  },
  {
    pattern: /ollama|fetch|network|connect|econn|応答が空|サーバー/i,
    message: 'AIサーバーに接続できなかったため、処理できませんでした。',
  },
];

/** どの規則にも当たらない場合の既定文言。生の理由は出さない。 */
export const AI_ERROR_FALLBACK_MESSAGE =
  'AIの処理に失敗しました。しばらくしてから、もう一度お試しください。';

/**
 * 生の error_message を利用者向け文言へ変換する。
 *
 * - 既知のパターンは原因に応じた文言へ寄せる。
 * - 未知の文言は、技術用語や内部情報が混ざっている前提で既定文言に倒す
 *   （生の理由をそのまま出すと、モデル名・接続先・スタック等が漏れうる）。
 */
export function humanAiError(errorMessage: string | null | undefined): string {
  if (!errorMessage) return AI_ERROR_FALLBACK_MESSAGE;
  for (const rule of ERROR_RULES) {
    if (rule.pattern.test(errorMessage)) return rule.message;
  }
  return AI_ERROR_FALLBACK_MESSAGE;
}

/**
 * 9-4 不備チェックの件数サマリー文言。
 * 一覧より先に「全部で何件か」を出すための1行を作る。
 *
 * @param ruleCount ルールベース（①）の指摘件数
 * @param llmCount LLM（②）の指摘件数。未実施のときは llmChecked=false を渡す
 * @param llmChecked ②を実施済みか。未実施なら件数に含めず、その旨を添える
 */
export function defectSummaryText(
  ruleCount: number,
  llmCount: number,
  llmChecked: boolean,
): string {
  if (!llmChecked) {
    return ruleCount === 0
      ? '指摘はありません（ルール 0件 / 要確認 未実施）'
      : `${ruleCount}件の指摘があります（ルール ${ruleCount}件 / 要確認 未実施）`;
  }
  const total = ruleCount + llmCount;
  return total === 0
    ? '指摘はありません（ルール 0件 / 要確認 0件）'
    : `${total}件の指摘があります（ルール ${ruleCount}件 / 要確認 ${llmCount}件）`;
}
