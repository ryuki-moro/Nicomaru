/**
 * planner／admin／system_admin 側のパンくず（4-3 全画面共通仕様）。
 *
 * 各画面が `<nav aria-label="パンくず">` を自前で書いていたため、
 * 起点（ダッシュボードから始まるか）や現在地の書き方が画面ごとにずれていた。
 * 並べる項目だけを画面が決め、見た目と現在地の示し方はここに寄せる。
 *
 * 起点のきまり（docs/ui-review/p2/back-navigation.md）:
 *   - 起点はそのロールの着地点（landingPathFor）にする。planner・admin はダッシュボード、
 *     system_admin 専用の画面（式場管理・利用者管理）は利用状況から始める
 *   - 最後の項目が現在地。href を渡さず、aria-current="page" で示す
 *   - 起点と次の項目が同じ画面名なら起点を省く（D1版では着地点が一覧画面そのもののため）
 *   - D1版ではダッシュボード・利用状況への項目を出さない（画面がない）
 */
import Link from 'next/link';

import type { Crumb } from '@/components/layout/breadcrumbItems';
import { publicD1 } from '@/lib/d1/mode';

export { DASHBOARD_CRUMB, homeCrumbFor, type Crumb } from '@/components/layout/breadcrumbItems';

export function Breadcrumbs({
  items: given,
  className,
}: {
  items: readonly Crumb[];
  className?: string;
}) {
  // D1版にはダッシュボード・利用状況がないため、その起点は省く。
  const shown = publicD1()
    ? given.filter((crumb) => crumb.href !== '/dashboard' && crumb.href !== '/system')
    : given;
  const items = shown.length > 1 && shown[0].label === shown[1].label ? shown.slice(1) : shown;
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
