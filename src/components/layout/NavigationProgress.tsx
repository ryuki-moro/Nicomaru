'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/** useSearchParams と location.search の表記ゆれ（+ と %20 など）をそろえて比べる */
const toKey = (pathname: string, search: string) => {
  const query = new URLSearchParams(search).toString();
  return query ? `${pathname}?${query}` : pathname;
};
const currentUrl = () => toKey(location.pathname, location.search);

/**
 * 画面内リンクを押してから次の画面が出るまで、上端にバーを出す。
 * 画面は force-dynamic で描画を待つ間は何も変わらないため。loading.tsx を使わないのは、
 * 仮表示を先に送ると HTTP 200 が確定し、ページ内の notFound() が 404 を返せなくなるから。
 */
export function NavigationProgress() {
  const url = toKey(usePathname(), useSearchParams().toString());
  // 押した時点の URL。URL が変われば遷移が済んだとみなしてバーを消す
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const link = (event.target as Element | null)?.closest?.('a');
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download'))
        return;
      const to = new URL(link.href, location.href);
      // /api/ はファイルの受け取りなどで画面が変わらない
      if (to.origin !== location.origin || to.pathname.startsWith('/api/')) return;
      if (toKey(to.pathname, to.search) === currentUrl()) return;
      setFrom(currentUrl());
      // リダイレクトで同じ画面に戻ったときなど、URL が変わらなくても出しっぱなしにしない
      clearTimeout(timer);
      timer = setTimeout(() => setFrom(null), 15_000);
    };
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
      clearTimeout(timer);
    };
  }, []);

  if (from === null) return null;
  if (from !== url) {
    // 遷移が済んだら記録を消す（「戻る」で元の URL に戻ったときに再び出さない）
    setFrom(null);
    return null;
  }
  return (
    <div role="status" className="no-print fixed inset-x-0 top-0 z-50 h-1">
      <span className="sr-only">読み込み中…</span>
      <div className="h-full animate-pulse bg-primary motion-reduce:animate-none" />
    </div>
  );
}
