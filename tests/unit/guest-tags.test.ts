/**
 * ゲストのタグ: 回答からの自動タグと自由タグの組み立て、絞り込み（座席表での分類の前提）。
 */
import { describe, expect, it } from 'vitest';

import {
  AUTO_GUEST_TAGS,
  customTagKey,
  guestTags,
  matchesAllTags,
  type TaggableGuest,
} from '@/lib/guest-tags';

const guest = (overrides: Partial<TaggableGuest> = {}): TaggableGuest => ({
  guestSide: 'bride',
  relationship: 'friend',
  ageCategory: 'child',
  allergyNote: '',
  assistanceNeeds: [],
  tagIds: [],
  ...overrides,
});

const tags = [
  { id: 't1', name: '大学の友人' },
  { id: 't2', name: 'サークル' },
];

describe('guestTags', () => {
  it('回答から自動タグを付け、自由タグはタグ一覧の順で後ろに並べる', () => {
    const result = guestTags(
      guest({ allergyNote: 'えび', assistanceNeeds: ['mobility'], tagIds: ['t2', 't1'] }),
      tags,
    );
    expect(result.map((tag) => tag.key)).toEqual([
      'side:bride',
      'relationship:friend',
      'age:child',
      'allergy',
      'assistance:mobility',
      customTagKey('t1'),
      customTagKey('t2'),
    ]);
    expect(result.map((tag) => tag.label)).toEqual([
      '新婦側',
      '友人',
      '子ども',
      'アレルギーあり',
      '足腰',
      '大学の友人',
      'サークル',
    ]);
  });

  it('未回答の項目や消されたタグは付けない', () => {
    const result = guestTags(
      guest({ guestSide: null, relationship: null, ageCategory: null, tagIds: ['deleted'] }),
      tags,
    );
    expect(result).toEqual([]);
  });

  it('自動タグの key は座席表から参照できるよう固定の文字列にする', () => {
    expect(AUTO_GUEST_TAGS.map((tag) => tag.key)).toEqual([
      'side:groom',
      'side:bride',
      'relationship:family',
      'relationship:relative',
      'relationship:friend',
      'relationship:colleague',
      'relationship:teacher',
      'relationship:other',
      'age:adult',
      'age:child',
      'age:infant',
      'allergy',
      'assistance:mobility',
      'assistance:wheelchair',
      'assistance:pregnancy',
      'assistance:hearing',
      'assistance:vision',
      'assistance:other',
    ]);
  });
});

describe('matchesAllTags', () => {
  const personTags = guestTags(guest({ tagIds: ['t1'] }), tags);

  it('選んだタグをすべて持つ人だけを当てはめる', () => {
    expect(matchesAllTags(personTags, ['side:bride', customTagKey('t1')])).toBe(true);
    expect(matchesAllTags(personTags, ['side:bride', customTagKey('t2')])).toBe(false);
  });

  it('何も選んでいなければ全員が当てはまる', () => {
    expect(matchesAllTags(personTags, [])).toBe(true);
  });
});
