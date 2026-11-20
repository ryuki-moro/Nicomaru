/**
 * 「本文へ移動」リンク（WCAG 2.4.1 ブロックスキップ）。
 *
 * staff 側はヘッダーに役割の帯・ログアウト・折り返すグローバルナビがあり、キーボードでは本文に
 * 着くまで Tab を何度も押すことになる。ページ先頭に置き、普段は隠してフォーカスしたときだけ見せる。
 * 移動先は <main id={MAIN_CONTENT_ID}>。couple 側はヘッダーが最小構成で下部ナビは本文の後ろに
 * あるため置かない。
 */
export const MAIN_CONTENT_ID = 'main-content';

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="no-print sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-button focus:bg-surface focus:px-4 focus:py-3 focus:text-label focus:font-bold focus:text-primary focus:shadow"
    >
      本文へ移動
    </a>
  );
}
