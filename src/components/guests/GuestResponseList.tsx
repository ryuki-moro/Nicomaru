/**
 * ゲストの出欠回答の集計と一覧。新郎新婦のマイページとプランナーの案件詳細で共用する。
 * 回答単位（本人＋同伴者）でまとめ、アレルギーは料理の手配で見落とさないよう目立たせる。
 */
import {
  GUEST_AGE_CATEGORIES,
  GUEST_AGE_CATEGORY_LABEL,
  GUEST_GENDER_LABEL,
  GUEST_RELATIONSHIP_LABEL,
  PARTNER_ROLE_LABEL,
} from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import {
  summarizeGuestResponses,
  type GuestPerson,
  type GuestResponse,
} from '@/lib/services/guests';

/** 区分名の括弧書き（「（小学生）」など）は集計欄では省く。 */
const shortAgeLabel = (label: string) => label.replace(/（.*）$/, '');

export function GuestResponseList({ responses }: { responses: GuestResponse[] }) {
  if (responses.length === 0) {
    return <p className="text-label text-text-muted">まだ回答はありません。</p>;
  }
  const summary = summarizeGuestResponses(responses);

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryItem label="ご出席" value={`${summary.attendingPeople}名`} />
        <SummaryItem label="ご欠席" value={`${summary.declinedPeople}名`} />
        <SummaryItem
          label="出席の内訳"
          value={GUEST_AGE_CATEGORIES.map(
            (c) => `${shortAgeLabel(GUEST_AGE_CATEGORY_LABEL[c])}${summary.byAge[c]}`,
          ).join('・')}
        />
        <SummaryItem label="アレルギーあり" value={`${summary.allergyPeople}名`} />
      </dl>

      <ul className="flex flex-col gap-2">
        {responses.map((response) => (
          <li key={response.id} className="rounded-card border border-border-light p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${response.attending ? 'badge-success' : 'badge-neutral'}`}>
                {response.attending ? 'ご出席' : 'ご欠席'}
              </span>
              <span className="text-caption text-text-secondary">
                {[
                  response.guestSide && `${PARTNER_ROLE_LABEL[response.guestSide]}側`,
                  response.relationship && GUEST_RELATIONSHIP_LABEL[response.relationship],
                  response.people.length > 1 && `${response.people.length}名`,
                ]
                  .filter(Boolean)
                  .join('・')}
              </span>
              <span className="ml-auto text-caption text-text-muted">
                {formatDateTime(response.respondedAt)}
              </span>
            </div>
            <ul className="mt-2 flex flex-col gap-2">
              {response.people.map((person, index) => (
                <PersonRow key={person.id} person={person} companion={index > 0} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
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

function PersonRow({ person, companion }: { person: GuestPerson; companion: boolean }) {
  return (
    <li className="text-label">
      <p className="text-text-primary">
        {companion && <span className="text-caption text-text-muted">同伴　</span>}
        <span className="font-medium">{person.fullName}</span>
        {person.kana && <span className="text-caption text-text-muted">（{person.kana}）</span>}
      </p>
      <p className="text-caption text-text-secondary">
        {[
          person.ageCategory && GUEST_AGE_CATEGORY_LABEL[person.ageCategory],
          person.gender && GUEST_GENDER_LABEL[person.gender],
        ]
          .filter(Boolean)
          .join('・')}
      </p>
      {person.allergyNote && (
        <p className="mt-1 rounded-card bg-warning-bg px-2 py-1 text-caption text-warning-text">
          <span className="font-bold">アレルギー：</span>
          {person.allergyNote}
        </p>
      )}
    </li>
  );
}
