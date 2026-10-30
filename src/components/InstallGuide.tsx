'use client';

import { useEffect, useRef, useState } from 'react';

import { installGuideKind, type InstallGuideKind } from '@/lib/install-guide';

const DISMISSED_KEY = 'nicomaru.install-guide.dismissed';
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallGuide() {
  const [kind, setKind] = useState<InstallGuideKind>(null);
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [prompting, setPrompting] = useState(false);
  const dismissedRef = useRef(false);

  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)');
    try {
      dismissedRef.current = localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // 保存できない環境でも案内・閉じる操作は利用できる。
    }
    const currentKind = () =>
      installGuideKind({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        standalone:
          media.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
        dismissed: dismissedRef.current,
      });
    const update = () => setKind(currentKind());
    const beforeInstall = (event: Event) => {
      if (currentKind() !== 'android') return;
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    const installed = () => setKind(null);
    update();
    media.addEventListener('change', update);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installed);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  if (!kind) return null;

  function dismiss() {
    dismissedRef.current = true;
    setKind(null);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // この画面では閉じた状態を維持する。
    }
  }

  async function install() {
    if (!promptEvent || prompting) return;
    setPrompting(true);
    try {
      await promptEvent.prompt();
      if ((await promptEvent.userChoice).outcome === 'accepted') dismiss();
    } catch {
      // ブラウザが追加を中止した場合も、メニューからの手順を残す。
    } finally {
      setPromptEvent(null);
      setPrompting(false);
    }
  }

  return (
    <section className="card" aria-labelledby="install-guide-heading">
      <div className="flex items-start justify-between gap-3">
        <h2 id="install-guide-heading" className="section-head">
          ホーム画面からすぐに開く
        </h2>
        <button
          type="button"
          onClick={dismiss}
          className="btn-ghost shrink-0"
          aria-label="ホーム画面追加の案内を閉じる"
        >
          閉じる
        </button>
      </div>
      <p className="mt-2 text-label text-text-secondary">
        ホーム画面に追加すると、次回からにこまるを開きやすくなります。
      </p>
      {kind === 'ios' ? (
        <>
          <p className="mt-2 text-label text-text-secondary">
            Safari の「共有」から「ホーム画面に追加」を選んでください。
          </p>
          <p className="mt-2 text-label text-text-muted">
            ホーム画面から開くと、Safari とは別にログインが必要になる場合があります。
          </p>
        </>
      ) : promptEvent ? (
        <button type="button" onClick={install} disabled={prompting} className="btn-secondary mt-3">
          ホーム画面に追加する
        </button>
      ) : (
        <p className="mt-2 text-label text-text-secondary">
          Chrome
          のメニューから「ホーム画面に追加」または「アプリをインストール」を選んでください。表示名は端末によって異なります。
        </p>
      )}
    </section>
  );
}
