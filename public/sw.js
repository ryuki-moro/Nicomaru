/*
 * 個人情報を保存しないネットワーク専用Service Worker。
 * fetchを横取りせず、CacheStorage・オフライン代替ページ・送信再試行を使わない。
 * HTML/RSC/API/署名付きダウンロードURLをキャッシュ対象へ追加しないこと。
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
