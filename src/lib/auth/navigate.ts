/**
 * ログイン・ログアウトなど、セッションが切り替わった直後の画面遷移。
 *
 * クライアントルーター（router.replace + router.refresh）を使わず、ページ全体を読み直す。
 *
 * 以前は router.replace('/') の直後に router.refresh() を呼んでいた。`/` はサーバー側で
 * redirect() して役割ごとの着地点へ振り分けるため、クライアントでは
 * 「`/` の確定 → RedirectBoundary による着地点への再遷移 → refresh」が並行して走り、
 * どれが最後に勝つかがコンパイルや応答の速さで変わっていた。
 * その結果、URL が `/` や `/login` のまま止まることがあった。
 *
 * ページ全体の遷移なら、新しいセッション Cookie を付けた1本の要求になり、
 * サーバーの 307 をブラウザがそのままたどるので、順序の競合が起きない。
 * 古いセッションで描画した RSC のキャッシュも残らない。
 * replace にするのは、戻るボタンでログイン画面やログアウト前の画面へ戻さないため。
 */
export function navigateAfterSessionChange(path: string): void {
  window.location.replace(path);
}
