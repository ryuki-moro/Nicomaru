/** メッセージに添付された やること・ゲスト・席次 のカード。押すと該当の画面へ移る。 */
import Link from 'next/link';

import { TASK_STATUS_LABEL, type TaskStatus } from '@/lib/constants';
import type { RefView } from '@/lib/d1/messages';

const TYPE_LABEL = { task: 'やること', guest: 'ゲスト', seating: '席次' } as const;
const SEATING_STATUS_LABEL: Record<string, string> = {
  draft: '作成中',
  submitted: '提出済',
  approved: '確定',
  returned: '修正依頼中',
};

function statusLabel(ref: RefView): string | null {
  if (!ref.status) return null;
  if (ref.type === 'task') return TASK_STATUS_LABEL[ref.status as TaskStatus] ?? null;
  if (ref.type === 'seating') return SEATING_STATUS_LABEL[ref.status] ?? null;
  return null;
}

export function RefCard({ item: view }: { item: RefView }) {
  const status = statusLabel(view);
  const body = (
    <>
      <span className="text-caption text-text-muted">{TYPE_LABEL[view.type]}</span>
      <span className="block break-words text-label font-bold">
        {view.title ?? '表示できない項目'}
      </span>
      {status && <span className="text-caption text-text-muted">{status}</span>}
    </>
  );
  const base = 'block rounded-card border border-border-light bg-surface px-3 py-2 text-left';
  // 題名もリンクも出さない（権限がないか、消えた項目）
  if (!view.title || !view.href)
    return (
      <span className={`${base} text-text-muted`} data-ref-unavailable>
        {body}
      </span>
    );
  return (
    <Link href={view.href} className={`${base} text-text-primary hover:bg-field-filled-bg`}>
      {body}
    </Link>
  );
}
