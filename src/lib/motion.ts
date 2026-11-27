/**
 * 端末で「視差効果を減らす」（prefers-reduced-motion: reduce）が選ばれているときは、
 * スクロールのアニメーションをやめて一度に移動する。
 */
export function preferredScrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || !window.matchMedia) return 'auto';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
