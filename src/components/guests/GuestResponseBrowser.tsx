'use client';

/**
 * ゲストの回答一覧（タグで絞り込み・自由タグの付け外し）。
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
  GUEST_GENDER_LABEL,
  GUEST_RELATIONSHIP_LABEL,
  PARTNER_ROLE_LABEL,
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
              relationship: response.relationship,
              ageCategory: person.ageCategory,
              allergyNote: person.allergyNote,
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
      people: entry.people.filter((p) => matchesAllTags(p.tags, selected)),
    }))
    .filter((entry) => entry.people.length > 0);
  const visiblePeople = visible.reduce((sum, entry) => sum + entry.people.length, 0);

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
            <button type="button" className="text-link underline" onClick={() => setSelected([])}>
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
                    companion={response.people[0]?.id !== person.id}
                    personTags={personTags}
                    editable={editable}
                    editing={editingGuest === person.id}
                    onEdit={() => setEditingGuest(editingGuest === person.id ? null : person.id)}
                    editor={
                      <TagPicker
                        tags={tags}
                        initial={person.tagIds}
                        pending={pending}
                        onCancel={() => setEditingGuest(null)}
                        onSave={async (tagIds) => {
                          const saved = await mutate(() =>
                            api.put(`/api/cases/${caseId}/guests/${person.id}/tags`, { tagIds }),
                          );
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
  companion,
  personTags,
  editable,
  editing,
  onEdit,
  editor,
}: {
  person: GuestPerson;
  companion: boolean;
  personTags: GuestTag[];
  editable: boolean;
  editing: boolean;
  onEdit: () => void;
  editor: React.ReactNode;
}) {
  return (
    <li className="text-label">
      <div className="flex items-start gap-2">
        <div className="flex-1">
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
        </div>
        {editable && (
          <button
            type="button"
            className="btn-ghost min-h-[36px] px-3 py-1 text-caption"
            aria-expanded={editing}
            onClick={onEdit}
          >
            タグを編集
          </button>
        )}
      </div>
      {person.allergyNote && (
        <p className="mt-1 rounded-card bg-warning-bg px-2 py-1 text-caption text-warning-text">
          <span className="font-bold">アレルギー：</span>
          {person.allergyNote}
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

/** 1人分の自由タグを選んで保存する。自動タグは回答から決まるので選ばせない。 */
function TagPicker({
  tags,
  initial,
  pending,
  onSave,
  onCancel,
}: {
  tags: GuestCustomTag[];
  initial: string[];
  pending: boolean;
  onSave: (tagIds: string[]) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState(initial);
  if (tags.length === 0) {
    return (
      <p className="rounded-card border border-border-mid p-3 text-caption text-text-secondary">
        自由タグがまだありません。上の「タグを管理」から作成してください。
      </p>
    );
  }
  return (
    <div className="rounded-card border border-border-mid p-3">
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {tags.map((tag) => (
          <label key={tag.id} className="flex items-center gap-2 text-label">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={chosen.includes(tag.id)}
              onChange={(e) =>
                setChosen((ids) =>
                  e.target.checked ? [...ids, tag.id] : ids.filter((id) => id !== tag.id),
                )
              }
            />
            {tag.name}
          </label>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn-ghost"
          disabled={pending}
          onClick={() => onSave(chosen)}
        >
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
