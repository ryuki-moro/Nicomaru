'use client';

import { useRef, useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import {
  GUEST_AGE_CATEGORIES,
  GUEST_AGE_CATEGORY_LABEL,
  GUEST_ASSISTANCE_NEEDS,
  GUEST_ASSISTANCE_NEED_LABEL,
  GUEST_GENDERS,
  GUEST_GENDER_LABEL,
  GUEST_RELATIONSHIPS,
  GUEST_RELATIONSHIP_LABEL,
  GUEST_RESPONSE_MAX_PEOPLE,
  INPUT_LIMITS,
  PARTNER_ROLES,
  type GuestAgeCategory,
  type GuestAssistanceNeed,
  type GuestGender,
  type GuestRelationship,
  type PartnerRole,
} from '@/lib/constants';

interface PersonDraft {
  /** React の key 用。送信はしない */
  key: number;
  fullName: string;
  kana: string;
  ageCategory: GuestAgeCategory | '';
  gender: GuestGender | '';
  hasAllergy: boolean;
  allergyNote: string;
  hasAssistance: boolean;
  assistanceNeeds: GuestAssistanceNeed[];
  assistanceNote: string;
}

const emptyPerson = (key: number): PersonDraft => ({
  key,
  fullName: '',
  kana: '',
  ageCategory: '',
  gender: '',
  hasAllergy: false,
  allergyNote: '',
  hasAssistance: false,
  assistanceNeeds: [],
  assistanceNote: '',
});

/** 選択式の行。選択中は枠と文字でも示す（色だけに頼らない）。 */
function ChoiceCard({
  name,
  checked,
  label,
  onSelect,
}: {
  name: string;
  checked: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={`card flex flex-1 cursor-pointer items-center gap-3 text-base ${
        checked ? 'border-primary bg-info-bg ring-1 ring-primary' : ''
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="accent-primary"
      />
      <span className={checked ? 'font-bold' : ''}>{label}</span>
    </label>
  );
}

export function GuestResponseForm({
  token,
  sideLabels,
}: {
  token: string;
  sideLabels: Record<PartnerRole, string>;
}) {
  const [attending, setAttending] = useState<boolean | null>(null);
  const [guestSide, setGuestSide] = useState<PartnerRole | ''>('');
  const [relationship, setRelationship] = useState<GuestRelationship | ''>('');
  // key はサーバー描画と一致させるため、モジュール変数ではなくフォームごとに数える
  const nextKey = useRef(1);
  const [people, setPeople] = useState<PersonDraft[]>(() => [emptyPerson(0)]);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ people: number; attending: boolean } | null>(null);

  // 直した項目のエラーはその場で消す。送信し直すまで古い指摘が残ると、どこが未入力か分からない
  const clearErrors = (matches: (field: string) => boolean) =>
    setFieldErrors((errors) =>
      Object.keys(errors).some(matches)
        ? Object.fromEntries(Object.entries(errors).filter(([field]) => !matches(field)))
        : errors,
    );

  const update = (index: number, patch: Partial<PersonDraft>) => {
    setPeople((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));
    // チェックや区分を変えたら、それに対応する内容欄のエラーも消す
    const NOTE_FIELD: Record<string, string> = {
      hasAllergy: 'allergyNote',
      hasAssistance: 'assistanceNote',
      assistanceNeeds: 'assistanceNote',
    };
    const fields = Object.keys(patch).map(
      (field) => `guests.${index}.${NOTE_FIELD[field] ?? field}`,
    );
    clearErrors((field) => fields.includes(field));
  };

  // 同伴者を消すと番号がずれるため、人ごとのエラーはまとめて消す
  const removePerson = (key: number) => {
    setPeople((list) => list.filter((p) => p.key !== key));
    clearErrors((field) => field.startsWith('guests'));
  };

  // 欠席の回答に同伴者は付けられない（API と同じ規則）。切り替えたら本人だけ残す
  const chooseAttendance = (value: boolean) => {
    setAttending(value);
    clearErrors((field) => field === 'attending' || field === 'guests');
    if (!value) setPeople((list) => list.slice(0, 1));
  };

  const submit = async () => {
    setError(null);
    // 「ある」にチェックして中身が空だと、保存時に「なし」と区別できなくなる
    const missing: Record<string, string> = {};
    people.forEach((p, index) => {
      if (!attending) return;
      if (p.hasAllergy && !p.allergyNote.trim()) {
        missing[`guests.${index}.allergyNote`] = 'アレルギーの内容をご記入ください';
      }
      if (p.hasAssistance && p.assistanceNeeds.length === 0 && !p.assistanceNote.trim()) {
        missing[`guests.${index}.assistanceNote`] = '当てはまるものを選ぶか、内容をご記入ください';
      } else if (
        p.hasAssistance &&
        p.assistanceNeeds.includes('other') &&
        !p.assistanceNote.trim()
      ) {
        missing[`guests.${index}.assistanceNote`] = '「その他」を選んだ場合は内容をご記入ください';
      }
    });
    setFieldErrors(missing);
    if (Object.keys(missing).length > 0) {
      setError('入力内容をご確認ください');
      return;
    }
    setPending(true);
    try {
      const result = await api.post<{ people: number; attending: boolean }>(`/api/rsvp/${token}`, {
        attending,
        guestSide: guestSide || undefined,
        relationship: relationship || undefined,
        guests: people.map((p) => ({
          fullName: p.fullName,
          kana: p.kana || null,
          ageCategory: p.ageCategory || undefined,
          gender: p.gender || undefined,
          allergyNote: attending && p.hasAllergy ? p.allergyNote : null,
          assistanceNeeds: attending && p.hasAssistance ? p.assistanceNeeds : [],
          assistanceNote: attending && p.hasAssistance ? p.assistanceNote : null,
        })),
      });
      setDone(result);
      window.scrollTo({ top: 0 });
    } catch (cause) {
      if (cause instanceof ApiCallError) {
        setError(cause.message);
        setFieldErrors(cause.fieldErrors);
      } else {
        setError('送信できませんでした。通信状況をご確認のうえ、もう一度お試しください');
      }
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <div className="card flex flex-col gap-3" role="status">
        <h2 className="section-head">ご回答ありがとうございました</h2>
        <p className="text-label text-text-secondary">
          {done.attending
            ? `${done.people}名さまのご出席を承りました。当日お会いできることを楽しみにしております。`
            : 'ご欠席の旨を承りました。ご連絡いただきありがとうございました。'}
        </p>
        <p className="text-caption text-text-muted">
          内容を変更したい場合は、新郎新婦へ直接お知らせください。
        </p>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setDone(null);
            setAttending(null);
            setGuestSide('');
            setRelationship('');
            setPeople([emptyPerson(nextKey.current++)]);
          }}
        >
          別の方の回答をする
        </button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void submit();
      }}
    >
      <ErrorSummary message={error} />

      <fieldset>
        <legend className="field-label">ご出欠</legend>
        <div className="flex gap-3">
          <ChoiceCard
            name="attending"
            label="ご出席"
            checked={attending === true}
            onSelect={() => chooseAttendance(true)}
          />
          <ChoiceCard
            name="attending"
            label="ご欠席"
            checked={attending === false}
            onSelect={() => chooseAttendance(false)}
          />
        </div>
        <FieldError message={fieldErrors.attending} />
      </fieldset>

      <fieldset>
        <legend className="field-label">どちらのゲストですか</legend>
        <div className="flex flex-col gap-2 sm:flex-row">
          {PARTNER_ROLES.map((role) => (
            <ChoiceCard
              key={role}
              name="guest-side"
              label={sideLabels[role]}
              checked={guestSide === role}
              onSelect={() => {
                setGuestSide(role);
                clearErrors((field) => field === 'guestSide');
              }}
            />
          ))}
        </div>
        <FieldError message={fieldErrors.guestSide} />
      </fieldset>

      <div>
        <label className="field-label" htmlFor="rsvp-relationship">
          新郎新婦とのご関係
        </label>
        <select
          id="rsvp-relationship"
          className="field"
          value={relationship}
          aria-invalid={fieldErrors.relationship ? true : undefined}
          onChange={(e) => {
            setRelationship(e.target.value as GuestRelationship | '');
            clearErrors((field) => field === 'relationship');
          }}
        >
          <option value="">選択してください</option>
          {GUEST_RELATIONSHIPS.map((value) => (
            <option key={value} value={value}>
              {GUEST_RELATIONSHIP_LABEL[value]}
            </option>
          ))}
        </select>
        <FieldError message={fieldErrors.relationship} />
      </div>

      {people.map((person, index) => {
        const prefix = `guests.${index}`;
        const id = (field: string) => `rsvp-${person.key}-${field}`;
        return (
          <section key={person.key} className="card flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-label font-bold text-text-primary">
                {index === 0 ? 'ご本人さま' : `同伴者 ${index}`}
              </h2>
              {index > 0 && (
                <button
                  type="button"
                  className="btn-ghost text-caption"
                  onClick={() => removePerson(person.key)}
                >
                  削除
                </button>
              )}
            </div>

            <div>
              <label className="field-label" htmlFor={id('name')}>
                お名前
              </label>
              <input
                id={id('name')}
                className="field"
                autoComplete={index === 0 ? 'name' : 'off'}
                maxLength={INPUT_LIMITS.shortText}
                placeholder="山田 花子"
                value={person.fullName}
                aria-invalid={fieldErrors[`${prefix}.fullName`] ? true : undefined}
                onChange={(e) => update(index, { fullName: e.target.value })}
              />
              <FieldError message={fieldErrors[`${prefix}.fullName`]} />
            </div>

            <div>
              <label className="field-label" htmlFor={id('kana')}>
                ふりがな（任意）
              </label>
              <input
                id={id('kana')}
                className="field"
                maxLength={INPUT_LIMITS.shortText}
                placeholder="やまだ はなこ"
                value={person.kana}
                onChange={(e) => update(index, { kana: e.target.value })}
              />
              <FieldError message={fieldErrors[`${prefix}.kana`]} />
            </div>

            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex-1">
                <label className="field-label" htmlFor={id('age')}>
                  年齢区分
                </label>
                <select
                  id={id('age')}
                  className="field"
                  value={person.ageCategory}
                  aria-invalid={fieldErrors[`${prefix}.ageCategory`] ? true : undefined}
                  onChange={(e) =>
                    update(index, { ageCategory: e.target.value as GuestAgeCategory | '' })
                  }
                >
                  <option value="">選択してください</option>
                  {GUEST_AGE_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {GUEST_AGE_CATEGORY_LABEL[value]}
                    </option>
                  ))}
                </select>
                <FieldError message={fieldErrors[`${prefix}.ageCategory`]} />
              </div>
              <div className="flex-1">
                <label className="field-label" htmlFor={id('gender')}>
                  性別
                </label>
                <select
                  id={id('gender')}
                  className="field"
                  value={person.gender}
                  aria-invalid={fieldErrors[`${prefix}.gender`] ? true : undefined}
                  onChange={(e) => update(index, { gender: e.target.value as GuestGender | '' })}
                >
                  <option value="">選択してください</option>
                  {GUEST_GENDERS.map((value) => (
                    <option key={value} value={value}>
                      {GUEST_GENDER_LABEL[value]}
                    </option>
                  ))}
                </select>
                <FieldError message={fieldErrors[`${prefix}.gender`]} />
              </div>
            </div>

            {/*
              特記事項。食事と当日の席・動線の手配に使うため、出席のときだけ伺う。
              「ある」にチェックした人だけ詳細を出し、ほとんどの方は2つのチェックを素通りできるようにする
            */}
            {attending && (
              <fieldset className="flex flex-col gap-3 border-t border-border-light pt-3">
                <legend className="text-label font-bold text-text-primary">特記事項</legend>
                <div>
                  <label className="flex items-start gap-2 text-label text-text-primary">
                    <input
                      type="checkbox"
                      className="mt-[3px] h-4 w-4 accent-primary"
                      checked={person.hasAllergy}
                      onChange={(e) => update(index, { hasAllergy: e.target.checked })}
                    />
                    <span>食物アレルギー・食べられないものがある</span>
                  </label>
                  {person.hasAllergy && (
                    <>
                      <label className="field-label mt-2" htmlFor={id('allergy')}>
                        内容（食材と症状の程度など）
                      </label>
                      <textarea
                        id={id('allergy')}
                        className="field min-h-[80px]"
                        maxLength={INPUT_LIMITS.guestAllergyNote}
                        placeholder="例：えび・かに（少量でも不可）"
                        value={person.allergyNote}
                        onChange={(e) => update(index, { allergyNote: e.target.value })}
                      />
                      <FieldError message={fieldErrors[`${prefix}.allergyNote`]} />
                    </>
                  )}
                </div>

                <div>
                  <label className="flex items-start gap-2 text-label text-text-primary">
                    <input
                      type="checkbox"
                      className="mt-[3px] h-4 w-4 accent-primary"
                      checked={person.hasAssistance}
                      onChange={(e) => update(index, { hasAssistance: e.target.checked })}
                    />
                    <span>お席や移動で配慮が必要な身体的なご事情がある</span>
                  </label>
                  {person.hasAssistance && (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="text-caption text-text-secondary">
                        当てはまるものをお選びください（複数可）。お席の位置などの参考にいたします。
                      </p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {GUEST_ASSISTANCE_NEEDS.map((need) => (
                          <label key={need} className="flex items-center gap-2 text-label">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-primary"
                              checked={person.assistanceNeeds.includes(need)}
                              onChange={(e) =>
                                update(index, {
                                  assistanceNeeds: e.target.checked
                                    ? [...person.assistanceNeeds, need]
                                    : person.assistanceNeeds.filter((n) => n !== need),
                                })
                              }
                            />
                            {GUEST_ASSISTANCE_NEED_LABEL[need]}
                          </label>
                        ))}
                      </div>
                      <label className="field-label" htmlFor={id('assistance')}>
                        {person.assistanceNeeds.includes('other') ? '内容' : '補足（任意）'}
                      </label>
                      <textarea
                        id={id('assistance')}
                        className="field min-h-[80px]"
                        maxLength={INPUT_LIMITS.guestAssistanceNote}
                        placeholder="例：長時間の立ち歩きが難しいため、出入口に近い席を希望します"
                        value={person.assistanceNote}
                        aria-invalid={fieldErrors[`${prefix}.assistanceNote`] ? true : undefined}
                        onChange={(e) => update(index, { assistanceNote: e.target.value })}
                      />
                      <FieldError message={fieldErrors[`${prefix}.assistanceNote`]} />
                    </div>
                  )}
                </div>
              </fieldset>
            )}
          </section>
        );
      })}

      {attending && people.length < GUEST_RESPONSE_MAX_PEOPLE && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            const key = nextKey.current++;
            setPeople((list) => [...list, emptyPerson(key)]);
          }}
        >
          ＋ 同伴者を追加
        </button>
      )}
      <FieldError message={fieldErrors.guests} />

      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? '送信しています…' : '回答を送信する'}
      </button>
    </form>
  );
}
