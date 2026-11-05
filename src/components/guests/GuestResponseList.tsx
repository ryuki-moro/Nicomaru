/**
 * ゲストの出欠回答の集計と一覧。新郎新婦のマイページとプランナーの案件詳細で共用する。
 * 集計はサーバーで行い、一覧（タグの絞り込み・付け外し）はブラウザー側の GuestResponseBrowser に任せる。
 */
import { GuestResponseBrowser } from '@/components/guests/GuestResponseBrowser';
import { GUEST_AGE_CATEGORIES, GUEST_AGE_CATEGORY_LABEL } from '@/lib/constants';
import { summarizeGuestResponses, type GuestBook } from '@/lib/services/guests';

/** 区分名の括弧書き（「（小学生）」など）は集計欄では省く。 */
const shortAgeLabel = (label: string) => label.replace(/（.*）$/, '');

export function GuestResponseList({
  caseId,
  book,
  editable,
}: {
  caseId: string;
  book: GuestBook;
  editable: boolean;
}) {
  if (book.responses.length === 0) {
    return <p className="text-label text-text-muted">まだ回答はありません。</p>;
  }
  const summary = summarizeGuestResponses(book.responses);

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <SummaryItem label="ご出席" value={`${summary.attendingPeople}名`} />
        <SummaryItem label="ご欠席" value={`${summary.declinedPeople}名`} />
        <SummaryItem
          label="出席の内訳"
          value={GUEST_AGE_CATEGORIES.map(
            (c) => `${shortAgeLabel(GUEST_AGE_CATEGORY_LABEL[c])}${summary.byAge[c]}`,
          ).join('・')}
        />
        <SummaryItem label="アレルギーあり" value={`${summary.allergyPeople}名`} />
        <SummaryItem label="身体的なご事情あり" value={`${summary.assistancePeople}名`} />
      </dl>

      <GuestResponseBrowser
        caseId={caseId}
        responses={book.responses}
        tags={book.tags}
        editable={editable}
      />
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card bg-field-filled-bg px-3 py-2">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-label font-bold text-text-primary">{value}</dd>
    </div>
  );
}
