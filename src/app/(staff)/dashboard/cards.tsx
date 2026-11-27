import Link from 'next/link';

/** ダッシュボード（D01）の部品。プランナー向けと運営向けで共有する。 */
export function SummaryCard({
  label,
  value,
  unit,
  note,
  href,
  linkLabel,
}: {
  label: string;
  value: number;
  unit: string;
  note?: string;
  /** 件数から移動できる先。指定するとカード全体がリンクになる */
  href?: string;
  /** リンクであることを文字でも示す（色や枠だけに頼らない） */
  linkLabel?: string;
}) {
  const body = (
    <>
      <p className="text-caption text-text-muted">{label}</p>
      <p className="mt-[2px]">
        <span className="text-[28px] font-bold leading-9 text-text-primary">{value}</span>
        <span className="ml-1 text-label text-text-secondary">{unit}</span>
      </p>
      {note && <p className="text-caption text-text-muted">{note}</p>}
      {href && linkLabel && (
        <p className="flex items-center gap-1 text-caption font-bold text-link">
          {linkLabel}
          <ChevronRight small />
        </p>
      )}
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        prefetch={false}
        className="card block py-3 transition-colors hover:bg-field-filled-bg"
      >
        {body}
      </Link>
    );
  }
  return <div className="card py-3">{body}</div>;
}

/** Tabler Icons の chevron-right（design_guide 6 のアイコンセット）。 */
export function ChevronRight({ small = false }: { small?: boolean }) {
  const size = small ? 14 : 20;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={small ? 'shrink-0' : 'mt-[2px] shrink-0 text-text-muted'}
    >
      <path d="M9 6l6 6l-6 6" />
    </svg>
  );
}

export function NavCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="card block transition-colors hover:bg-field-filled-bg"
    >
      <p className="text-section font-bold text-text-primary">{title}</p>
      <p className="mt-1 text-caption text-text-muted">{description}</p>
    </Link>
  );
}
