export const FIRST_SCREEN_MARK = 'nicomaru:first-screen-heading';

/** addInitScript用。外側の変数を参照せず、対象文書のブラウザー時計だけで測る。 */
export function installFirstScreenMark({
  pathname,
  heading,
  markName,
  timeoutMs,
}: {
  pathname: string;
  heading: string;
  markName: string;
  timeoutMs: number;
}) {
  if (window !== window.top || location.pathname !== pathname) return;

  let stopped = false;
  let frame = 0;
  let deadline = 0;
  const visible = (element: Element) => {
    if (!element.isConnected) return false;
    const bounds = element.getBoundingClientRect();
    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.bottom <= 0 ||
      bounds.right <= 0 ||
      bounds.top >= innerHeight ||
      bounds.left >= innerWidth
    )
      return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility !== 'visible' ||
        style.opacity === '0' ||
        style.contentVisibility === 'hidden'
      )
        return false;
    }
    return true;
  };
  const stop = () => {
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(deadline);
    window.removeEventListener('load', inspect);
    window.removeEventListener('pagehide', stop);
  };
  const inspect = () => {
    if (stopped || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const target = Array.from(
        document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'),
      ).find(
        (element) =>
          element.textContent?.replace(/\s+/g, ' ').trim() === heading && visible(element),
      );
      if (!target) return;
      // 次の描画フレームでも表示されていることを確認する。実際のLCPの代用ではない。
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (stopped || !visible(target)) return;
        performance.mark(markName);
        stop();
      });
    });
  };
  const observer = new MutationObserver(inspect);
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'style'],
  });
  window.addEventListener('load', inspect);
  window.addEventListener('pagehide', stop, { once: true });
  // 見出し不在・遷移失敗でもobserver/rAF/タイマーを残し続けない。
  deadline = window.setTimeout(stop, timeoutMs);
  inspect();
}
