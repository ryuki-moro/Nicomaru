'use client';

/**
 * ゲストの回答一覧（確認済みの切り替え・ご関係/役割/肩書きの修正・タグで絞り込み・自由タグの付け外し）。
 *
 * 席次に入るのは出席かつ新郎新婦が確認済みにした人（#179）。新しく届いた回答は確認待ちになる。
 *
 * 自動タグ（新郎新婦側・関係・年齢区分・アレルギー）は回答から導き、自由タグは案件ごとに作る。
 * 座席表で卓の役割に沿って分類するための下ごしらえで、新郎新婦が付け、担当プランナーも確認・修正できる。
 * 変更はAPIで保存したあと router.refresh() でサーバーの値を読み直す（画面だけ先に変えない）。
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import {
  GUEST_AGE_CATEGORY_LABEL,
  GUEST_ASSISTANCE_NEED_LABEL,
  GUEST_GENDER_LABEL,
  GUEST_RELATIONSHIPS,
  GUEST_RELATIONSHIP_LABEL,
  GUEST_SEAT_ROLES,
  GUEST_SEAT_ROLE_LABEL,
  GUEST_SEAT_TITLE_MAX,
  PARTNER_ROLE_LABEL,
  type GuestRelationship,
  type GuestSeatRole,
} from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import {
  AUTO_GUEST_TAGS,
  GUEST_TAG_MAX_PER_CASE,
  GUEST_TAG_NAME_MAX,
  customTagKey,
  guestTags,
  matchesAllTags,
  type GuestCustomTag,
  type GuestTag,
} from '@/lib/guest-tags';
import type { GuestPerson, GuestResponse } from '@/lib/services/guests';

interface Props {
  caseId: string;
  responses: GuestResponse[];
  tags: GuestCustomTag[];
  /** アーカイブ済みの案件などで変更させない場合は false */
  editable: boolean;
}

export function GuestResponseBrowser({ caseId, responses, tags, editable }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  // 確認待ちの人だけを出す（新しく届いた回答を見落とさないため）
  const [pendingOnly, setPendingOnly] = useState(false);
  const [editingGuest, setEditingGuest] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1人ずつのタグ。絞り込みもこの結果で判定する
  const tagged = useMemo(
    () =>
      responses.map((response) => ({
        response,
        people: response.people.map((person) => ({
          person,
          tags: guestTags(
            {
              guestSide: response.guestSide,
              relationship: person.relationship,
              ageCategory: person.ageCategory,
              allergyNote: person.allergyNote,
              assistanceNeeds: person.assistanceNeeds,
              seatRole: person.seatRole,
              tagIds: person.tagIds,
            },
            tags,
          ),
        })),
      })),
    [responses, tags],
  );

  const visible = tagged
    .map((entry) => ({
      ...entry,
      people: entry.people.filter(
        (p) =>
          matchesAllTags(p.tags, selected) &&
          (!pendingOnly || (entry.response.attending && !p.person.checked)),
      ),
    }))
    .filter((entry) => entry.people.length > 0);
  const visiblePeople = visible.reduce((sum, entry) => sum + entry.people.length, 0);
  const pendingCount = responses
    .filter((r) => r.attending)
    .reduce((sum, r) => sum + r.people.filter((p) => !p.checked).length, 0);

  // 選択中の自由タグが消された場合に、絞り込みが空振りし続けないようにする
  const filterTags: GuestTag[] = [
    ...AUTO_GUEST_TAGS,
    ...tags.map((tag) => ({ key: customTagKey(tag.id), label: tag.name, kind: 'custom' as const })),
  ];
  const activeSelected = selected.filter((key) => filterTags.some((tag) => tag.key === key));

  /** API を呼び、成功したらサーバーの値を読み直す。失敗はフォーム上部に出す。 */
  const mutate = async (call: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await call();
      router.refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof ApiCallError ? cause.message : '保存できませんでした。');
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorSummary message={error} />

      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-label text-text-primary" role="status">
          {pendingCount > 0
            ? `確認待ちのご出席が${pendingCount}名います。ご関係を確かめて「確認済みにする」を押してください。`
            : 'ご出席の方はすべて確認済みです。'}
        </p>
        <button
          type="button"
          className="btn-ghost min-h-[36px] px-3 py-1 text-caption"
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly((v) => !v)}
        >
          {pendingOnly ? '✓ 確認待ちだけ表示中' : '確認待ちだけ表示'}
        </button>
      </div>

      <fieldset>
        <legend className="mb-1 text-caption text-text-muted">
          タグで絞り込む（すべてに当てはまる方）
        </legend>
        <div className="flex flex-wrap gap-[6px]">
          {filterTags.map((tag) => {
            const on = activeSelected.includes(tag.key);
            return (
              <button
                key={tag.key}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setSelected((keys) =>
                    on ? keys.filter((key) => key !== tag.key) : [...keys, tag.key],
                  )
                }
                className={`rounded-full border px-3 py-1 text-caption ${
                  on
                    ? 'border-primary bg-primary font-bold text-white'
                    : tag.kind === 'custom'
                      ? 'border-primary text-primary-dark'
                      : 'border-border-mid text-text-secondary'
                }`}
              >
                {on && '✓ '}
                {tag.label}
              </button>
            );
          })}
        </div>
        {activeSelected.length > 0 && (
          <p
            className="mt-2 flex items-center gap-2 text-caption text-text-secondary"
            role="status"
          >
            {visiblePeople}名が当てはまります
            <button type="button" className="btn-ghost" onClick={() => setSelected([])}>
              絞り込みを解除
            </button>
          </p>
        )}
      </fieldset>

      {editable && <TagManager caseId={caseId} tags={tags} pending={pending} mutate={mutate} />}

      {visible.length === 0 ? (
        <p className="text-label text-text-muted">条件に当てはまる方はいません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map(({ response, people }) => (
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
              <ul className="mt-2 flex flex-col gap-3">
                {people.map(({ person, tags: personTags }) => (
                  <PersonRow
                    key={person.id}
                    person={person}
                    attending={response.attending}
                    companion={response.people[0]?.id !== person.id}
                    pending={pending}
                    onCheck={(checked) =>
                      mutate(() =>
                        api.patch(`/api/cases/${caseId}/guests/${person.id}`, { checked }),
                      )
                    }
                    personTags={personTags}
                    editable={editable}
                    editing={editingGuest === person.id}
                    onEdit={() => setEditingGuest(editingGuest === person.id ? null : person.id)}
                    editor={
                      <GuestEditor
                        person={person}
                        tags={tags}
                        pending={pending}
                        onCancel={() => setEditingGuest(null)}
                        onSave={async (review, tagIds) => {
                          // 確認・修正とタグは別のAPI。変わったほうだけ送る
                          const tagsChanged =
                            tagIds.length !== person.tagIds.length ||
                            tagIds.some((id) => !person.tagIds.includes(id));
                          const saved = await mutate(async () => {
                            if (Object.keys(review).length > 0) {
                              await api.patch(`/api/cases/${caseId}/guests/${person.id}`, review);
                            }
                            if (tagsChanged) {
                              await api.put(`/api/cases/${caseId}/guests/${person.id}/tags`, {
                                tagIds,
                              });
                            }
                          });
                          if (saved) setEditingGuest(null);
                        }}
                      />
                    }
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonRow({
  person,
  attending,
  companion,
  personTags,
  editable,
  pending,
  onCheck,
  editing,
  onEdit,
  editor,
}: {
  person: GuestPerson;
  attending: boolean;
  companion: boolean;
  personTags: GuestTag[];
  editable: boolean;
  pending: boolean;
  onCheck: (checked: boolean) => void;
  editing: boolean;
  onEdit: () => void;
  editor: React.ReactNode;
}) {
  const relationshipChanged = person.relationship !== person.answeredRelationship;
  return (
    <li className="text-label">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-text-primary">
            {/* 席次に入るのは出席かつ確認済みの人。色だけに頼らず文字でも示す */}
            {attending && (
              <span className={`badge ${person.checked ? 'badge-success' : 'badge-warning'}`}>
                {person.checked ? '確認済み' : '確認待ち'}
              </span>
            )}
            <span>
              {companion && <span className="text-caption text-text-muted">同伴　</span>}
              <span className="font-medium">{person.fullName}</span>
              {person.kana && (
                <span className="text-caption text-text-muted">（{person.kana}）</span>
              )}
            </span>
          </p>
          <p className="text-caption text-text-secondary">
            {[
              person.ageCategory && GUEST_AGE_CATEGORY_LABEL[person.ageCategory],
              person.gender && GUEST_GENDER_LABEL[person.gender],
              person.seatTitle && `肩書き：${person.seatTitle}`,
              person.seatRole && `役割：${GUEST_SEAT_ROLE_LABEL[person.seatRole]}`,
            ]
              .filter(Boolean)
              .join('・')}
          </p>
          {relationshipChanged && person.relationship && (
            <p className="text-caption text-text-muted">
              {`ご関係を「${GUEST_RELATIONSHIP_LABEL[person.relationship]}」に直しています（回答：${
                person.answeredRelationship
                  ? GUEST_RELATIONSHIP_LABEL[person.answeredRelationship]
                  : 'なし'
              }）`}
            </p>
          )}
        </div>
        {editable && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {attending && (
              <button
                type="button"
                className={`btn-ghost min-h-[36px] px-3 py-1 text-caption ${
                  person.checked ? '' : 'border-primary font-bold text-primary-dark'
                }`}
                disabled={pending}
                onClick={() => onCheck(!person.checked)}
              >
                {person.checked ? '確認待ちに戻す' : '確認済みにする'}
              </button>
            )}
            <button
              type="button"
              className="btn-ghost min-h-[36px] px-3 py-1 text-caption"
              aria-expanded={editing}
              onClick={onEdit}
            >
              編集
            </button>
          </div>
        )}
      </div>
      {person.allergyNote && (
        <p className="mt-1 rounded-card bg-warning-bg px-2 py-1 text-caption text-warning-text">
          <span className="font-bold">アレルギー：</span>
          {person.allergyNote}
        </p>
      )}
      {(person.assistanceNeeds.length > 0 || person.assistanceNote) && (
        <p className="mt-1 rounded-card bg-info-bg px-2 py-1 text-caption text-text-primary">
          <span className="font-bold">身体的なご事情：</span>
          {[
            person.assistanceNeeds
              .filter((need) => need !== 'other')
              .map((need) => GUEST_ASSISTANCE_NEED_LABEL[need])
              .join('・'),
            person.assistanceNote,
          ]
            .filter(Boolean)
            .join('／')}
        </p>
      )}
      {personTags.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1" aria-label="タグ">
          {personTags.map((tag) => (
            <li
              key={tag.key}
              className={`rounded-full px-2 py-[1px] text-caption ${
                tag.kind === 'custom'
                  ? 'bg-primary text-white'
                  : 'bg-field-filled-bg text-text-secondary'
              }`}
            >
              {tag.label}
            </li>
          ))}
        </ul>
      )}
      {editing && <div className="mt-2">{editor}</div>}
    </li>
  );
}

/**
 * 1人分の確認・修正（ご関係・役割・肩書き）と自由タグの付け外し。
 * 自動タグは回答と上の項目から決まるので、ここでは選ばせない。
 */
interface ReviewPatch {
  relationship?: GuestRelationship;
  seatRole?: GuestSeatRole | null;
  seatTitle?: string | null;
}

function GuestEditor({
  person,
  tags,
  pending,
  onSave,
  onCancel,
}: {
  person: GuestPerson;
  tags: GuestCustomTag[];
  pending: boolean;
  onSave: (review: ReviewPatch, tagIds: string[]) => void;
  onCancel: () => void;
}) {
  const [relationship, setRelationship] = useState<GuestRelationship | ''>(
    person.relationship ?? '',
  );
  const [seatRole, setSeatRole] = useState<GuestSeatRole | ''>(person.seatRole ?? '');
  const [seatTitle, setSeatTitle] = useState(person.customSeatTitle ?? '');
  const [chosen, setChosen] = useState(person.tagIds);
  const id = (field: string) => `guest-${person.id}-${field}`;

  const save = () => {
    // 変わった項目だけを送る（送らない項目は保存済みの値のまま）
    const review: ReviewPatch = {};
    if (relationship && relationship !== person.relationship) review.relationship = relationship;
    if ((seatRole || null) !== person.seatRole) review.seatRole = seatRole || null;
    if ((seatTitle.trim() || null) !== person.customSeatTitle) {
      review.seatTitle = seatTitle.trim() || null;
    }
    onSave(review, chosen);
  };

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border-mid p-3">
      <div>
        <label className="field-label" htmlFor={id('relationship')}>
          ご関係
        </label>
        <select
          id={id('relationship')}
          className="field"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as GuestRelationship | '')}
        >
          {!person.relationship && <option value="">選択してください</option>}
          {GUEST_RELATIONSHIPS.map((value) => (
            <option key={value} value={value}>
              {GUEST_RELATIONSHIP_LABEL[value]}
              {value === person.answeredRelationship ? '（回答のまま）' : ''}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="field-label" htmlFor={id('role')}>
          役割
        </label>
        <select
          id={id('role')}
          className="field"
          value={seatRole}
          onChange={(e) => setSeatRole(e.target.value as GuestSeatRole | '')}
        >
          <option value="">なし</option>
          {GUEST_SEAT_ROLES.map((value) => (
            <option key={value} value={value}>
              {GUEST_SEAT_ROLE_LABEL[value]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="field-label" htmlFor={id('title')}>
          {`肩書き（席次表に載せます。空欄なら「${person.suggestedSeatTitle}」）`}
        </label>
        <input
          id={id('title')}
          className="field"
          maxLength={GUEST_SEAT_TITLE_MAX}
          placeholder={person.suggestedSeatTitle}
          value={seatTitle}
          onChange={(e) => setSeatTitle(e.target.value)}
        />
      </div>
      <fieldset>
        <legend className="field-label">自由タグ</legend>
        {tags.length === 0 ? (
          <p className="text-caption text-text-secondary">
            自由タグがまだありません。上の「タグを管理」から作成できます。
          </p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {tags.map((tag) => (
              <label key={tag.id} className="flex items-center gap-2 text-label">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={chosen.includes(tag.id)}
                  onChange={(e) =>
                    setChosen((ids) =>
                      e.target.checked ? [...ids, tag.id] : ids.filter((tid) => tid !== tag.id),
                    )
                  }
                />
                {tag.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost" disabled={pending} onClick={save}>
          保存
        </button>
        <button type="button" className="btn-ghost" disabled={pending} onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
}

/** 自由タグの作成・名前変更・削除。 */
function TagManager({
  caseId,
  tags,
  pending,
  mutate,
}: {
  caseId: string;
  tags: GuestCustomTag[];
  pending: boolean;
  mutate: (call: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  return (
    <div className="rounded-card border border-border-light p-3">
      <button
        type="button"
        className="text-label font-bold text-text-primary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} タグを管理（{tags.length}/{GUEST_TAG_MAX_PER_CASE}）
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-caption text-text-secondary">
            {'「大学の友人」「会社の同期」など、座席を決めるときの分け方をタグにできます。' +
              '新郎側・関係・年齢区分・アレルギーは回答から自動で付きます。'}
          </p>
          <form
            className="flex gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending || !name.trim()) return;
              const saved = await mutate(() =>
                api.post(`/api/cases/${caseId}/guest-tags`, { name }),
              );
              if (saved) setName('');
            }}
          >
            <input
              className="field"
              aria-label="新しいタグ名"
              placeholder="例：大学の友人"
              maxLength={GUEST_TAG_NAME_MAX}
              // 保存中に続けて打った文字が、保存後の欄のクリアで消えないようにする
              disabled={pending}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="btn-ghost shrink-0" disabled={pending || !name.trim()}>
              追加
            </button>
          </form>

          {tags.length > 0 && (
            <ul className="flex flex-col gap-2">
              {tags.map((tag) => (
                <li key={tag.id} className="flex flex-wrap items-center gap-2 text-label">
                  {renaming?.id === tag.id ? (
                    <>
                      <input
                        className="field w-auto flex-1"
                        aria-label={`${tag.name}の新しい名前`}
                        maxLength={GUEST_TAG_NAME_MAX}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: tag.id, name: e.target.value })}
                      />
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={pending || !renaming.name.trim()}
                        onClick={async () => {
                          const saved = await mutate(() =>
                            api.patch(`/api/cases/${caseId}/guest-tags/${tag.id}`, {
                              name: renaming.name,
                            }),
                          );
                          if (saved) setRenaming(null);
                        }}
                      >
                        保存
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => setRenaming(null)}>
                        やめる
                      </button>
                    </>
                  ) : deleting === tag.id ? (
                    <>
                      <span className="flex-1">
                        「{tag.name}」を削除しますか？付いているゲストからも外れます。
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={pending}
                        onClick={async () => {
                          const saved = await mutate(() =>
                            api.del(`/api/cases/${caseId}/guest-tags/${tag.id}`),
                          );
                          if (saved) setDeleting(null);
                        }}
                      >
                        削除する
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => setDeleting(null)}>
                        やめる
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1">{tag.name}</span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setRenaming({ id: tag.id, name: tag.name })}
                      >
                        名前を変更
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setDeleting(tag.id)}
                      >
                        削除
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
