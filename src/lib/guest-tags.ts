/**
 * ゲストのタグ（座席表で卓の役割と照らし合わせて分類するため）。
 *
 * - 自動タグ: 出欠回答の内容（新郎新婦側・関係・年齢区分・アレルギー）から導く。保存しない
 * - 自由タグ: 新郎新婦（担当プランナーも可）が案件ごとに作る分類。case_guest_tags に保存する
 *
 * どちらも key で識別する。自動タグの key は固定の文字列（例: 'side:groom'、'age:child'）なので、
 * 座席表側で「親族卓＝relationship:family と relationship:relative」のように卓の役割と結び付けられる。
 * 自由タグの key は 'tag:<タグID>'。
 *
 * ブラウザーからも使うため、ここでは node:crypto やDBクライアントに依存しない。
 */
import {
  GUEST_AGE_CATEGORIES,
  GUEST_AGE_CATEGORY_LABEL,
  GUEST_RELATIONSHIPS,
  GUEST_RELATIONSHIP_LABEL,
  PARTNER_ROLES,
  PARTNER_ROLE_LABEL,
  type GuestAgeCategory,
  type GuestRelationship,
  type PartnerRole,
} from '@/lib/constants';

/** 自由タグ名の上限。DB の varchar(20) と揃える。 */
export const GUEST_TAG_NAME_MAX = 20;
/** 1案件で作れる自由タグの数。絞り込みの候補が並びきらなくなるのを防ぐ。 */
export const GUEST_TAG_MAX_PER_CASE = 50;

export type GuestTagKind = 'auto' | 'custom';

export interface GuestTag {
  key: string;
  label: string;
  kind: GuestTagKind;
}

/** 自由タグ（case_guest_tags の1行）。 */
export interface GuestCustomTag {
  id: string;
  name: string;
}

export const ALLERGY_TAG_KEY = 'allergy';
export const customTagKey = (id: string) => `tag:${id}`;

/** 自動タグの全候補。絞り込みの選択肢を、回答の有無にかかわらず同じ並びで出すために使う。 */
export const AUTO_GUEST_TAGS: readonly GuestTag[] = [
  ...PARTNER_ROLES.map((role) => ({
    key: `side:${role}`,
    label: `${PARTNER_ROLE_LABEL[role]}側`,
    kind: 'auto' as const,
  })),
  ...GUEST_RELATIONSHIPS.map((value) => ({
    key: `relationship:${value}`,
    label: GUEST_RELATIONSHIP_LABEL[value],
    kind: 'auto' as const,
  })),
  ...GUEST_AGE_CATEGORIES.map((value) => ({
    key: `age:${value}`,
    // 「子ども（小学生）」の括弧書きはタグでは省く
    label: GUEST_AGE_CATEGORY_LABEL[value].replace(/（.*）$/, ''),
    kind: 'auto' as const,
  })),
  { key: ALLERGY_TAG_KEY, label: 'アレルギーあり', kind: 'auto' },
];

const AUTO_TAG_BY_KEY = new Map(AUTO_GUEST_TAGS.map((tag) => [tag.key, tag]));

export interface TaggableGuest {
  guestSide: PartnerRole | null;
  relationship: GuestRelationship | null;
  ageCategory: GuestAgeCategory | null;
  allergyNote: string;
  tagIds: string[];
}

/** 1人分のタグ。自動タグを先に、自由タグはタグ一覧の並び順で返す。 */
export function guestTags(guest: TaggableGuest, customTags: GuestCustomTag[]): GuestTag[] {
  const autoKeys = [
    guest.guestSide && `side:${guest.guestSide}`,
    guest.relationship && `relationship:${guest.relationship}`,
    guest.ageCategory && `age:${guest.ageCategory}`,
    guest.allergyNote && ALLERGY_TAG_KEY,
  ].filter((key): key is string => Boolean(key));
  return [
    ...autoKeys.flatMap((key) => AUTO_TAG_BY_KEY.get(key) ?? []),
    ...customTags
      .filter((tag) => guest.tagIds.includes(tag.id))
      .map((tag) => ({ key: customTagKey(tag.id), label: tag.name, kind: 'custom' as const })),
  ];
}

/** 選んだタグをすべて持つか（AND 条件）。何も選んでいなければ全員が当てはまる。 */
export function matchesAllTags(tags: GuestTag[], selectedKeys: string[]): boolean {
  return selectedKeys.every((key) => tags.some((tag) => tag.key === key));
}
