import Link from 'next/link';

/**
 * 「プランとやること」（T01・T03）の切り替え。
 * プランはやることのセットで、案件登録時にまとめて割り当てられる。
 * 2画面は一緒に使うため、ナビの1項目にまとめ、画面内のタブで行き来する。
 */
const TABS = [
  { href: '/plan-types', label: 'プラン' },
  { href: '/templates', label: 'やることの一覧' },
] as const;

export function PlanSetupTabs({ current }: { current: (typeof TABS)[number]['href'] }) {
  return (
    <div className="space-y-3">
      <h1 className="section-head">プランとやること</h1>
      <p className="text-caption text-text-muted">
        「やることの一覧」で新郎新婦に頼む準備を登録し、「プラン」でその組み合わせを決めます。
        案件を登録すると、選んだプランのやることがまとめて割り当てられます。
      </p>
      <nav aria-label="プランとやることの切り替え" className="border-b border-border-light">
        <ul className="flex gap-x-1">
          {TABS.map((tab) => (
            <li key={tab.href}>
              <Link
                href={tab.href}
                prefetch={false}
                aria-current={tab.href === current ? 'page' : undefined}
                className={`-mb-px block border-b-2 px-3 py-2 text-label ${
                  tab.href === current
                    ? 'border-primary font-bold text-primary'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
