/**
 * planner／admin／system_admin 側のパンくず（4-3 全画面共通仕様）。
 *
 * 各画面が `<nav aria-label="パンくず">` を自前で書いていたため、
 * 起点（ダッシュボードから始まるか）や現在地の書き方が画面ごとにずれていた。
 * 並べる項目だけを画面が決め、見た目と現在地の示し方はここに寄せる。
 *
 * 起点のきまり（docs/ui-review/p2/back-navigation.md）:
 *   - 起点はそのロールの着地点（landingPathFor）にする。planner は案件一覧、
 *     admin・system_admin はダッシュボード
 *   - 最後の項目が現在地。href を渡さず、aria-current="page" で示す
 *   - 起点と次の項目が同じ画面名なら起点を省き、現在地だけになったら出さない（visibleCrumbs）
 */
import { visibleCrumbs, type Crumb } from '@/components/layout/breadcrumbItems';
import Link from 'next/link';
export { DASHBOARD_CRUMB, homeCrumbFor, type Crumb } from '@/components/layout/breadcrumbItems';
export function Breadcrumbs({
  items: given,
  className,
}: {
  items: readonly Crumb[];
  className?: string;
}) {
  const items = visibleCrumbs(given);
  if (items.length === 0) return null;
  return (
    <nav aria-label="パンくず" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
        {items.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <span aria-hidden>/</span>}
            {crumb.href ? (
              <Link href={crumb.href} className="text-link hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="min-w-0 max-w-full break-all">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
