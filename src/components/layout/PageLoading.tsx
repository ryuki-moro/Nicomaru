/**
 * 画面遷移中の仮表示（各 loading.tsx から使う）。
 * 画面は force-dynamic で、これが無いとサーバーの描画が終わるまでクリックしても画面が変わらない。
 */
export function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">読み込み中…</span>
      <div className="h-6 w-1/3 animate-pulse rounded bg-border-light motion-reduce:animate-none" />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-20 animate-pulse rounded-card bg-border-light motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
