'use client';

import { useEffect } from 'react';

/** ホーム画面追加を補助する。個人情報をオフライン保存しない。 */
export function PwaRegistration() {
  useEffect(() => {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => {
        // 非対応ブラウザや登録失敗でも、通常のWebとして利用できる。
        console.warn('[pwa] Service Workerを登録できませんでした');
      });
  }, []);
  return null;
}
