import { describe, expect, it } from 'vitest';

import { seatGuestsFromBook } from '@/lib/seating/guests';
import type { GuestBook, GuestPerson, GuestResponse } from '@/lib/services/guests';

const person = (id: string, overrides: Partial<GuestPerson> = {}): GuestPerson => ({
  id,
  fullName: `ゲスト${id}`,
  kana: '',
  ageCategory: 'adult',
  gender: null,
  allergyNote: '',
  assistanceNeeds: [],
  assistanceNote: '',
  tagIds: [],
  relationship: 'friend',
  answeredRelationship: 'colleague',
  checked: true,
  seatRole: null,
  customSeatTitle: null,
  seatTitle: '新郎友人',
  suggestedSeatTitle: '新郎友人',
  ...overrides,
});

const response = (id: string, overrides: Partial<GuestResponse> = {}): GuestResponse => ({
  id,
  attending: true,
  guestSide: 'groom',
  relationship: 'colleague',
  respondedAt: '2026-11-01T00:00:00Z',
  people: [person(`${id}-1`)],
  ...overrides,
});

const book = (responses: GuestResponse[]): GuestBook => ({
  responses,
  tags: [{ id: '11111111-1111-4111-8111-111111111111', name: '同級生' }],
});

describe('seatGuestsFromBook', () => {
  it('出席で確認済みの人だけを席次の対象にする', () => {
    const result = seatGuestsFromBook(
      book([
        response('a', {
          people: [person('a-1'), person('a-2', { checked: false })],
        }),
        response('b', { attending: false }),
      ]),
    );
    expect(result.guests.map((g) => g.id)).toEqual(['a-1']);
    expect(Object.keys(result.info)).toEqual(['a-1']);
  });

  it('groupId は回答の ID、side は回答の新郎新婦側', () => {
    const result = seatGuestsFromBook(
      book([
        response('a', {
          guestSide: 'bride',
          people: [person('a-1'), person('a-2')],
        }),
      ]),
    );
    expect(result.guests.map((g) => [g.groupId, g.side])).toEqual([
      ['a', 'bride'],
      ['a', 'bride'],
    ]);
  });

  it('タグのキーに、直したご関係・役割・自由タグを含む', () => {
    const result = seatGuestsFromBook(
      book([
        response('a', {
          people: [
            person('a-1', {
              seatRole: 'chief',
              tagIds: ['11111111-1111-4111-8111-111111111111'],
            }),
          ],
        }),
      ]),
    );
    const keys = result.guests[0].tagKeys;
    expect(keys).toContain('side:groom');
    expect(keys).toContain('relationship:friend');
    expect(keys).not.toContain('relationship:colleague');
    expect(keys).toContain('role:chief');
    expect(keys).toContain('tag:11111111-1111-4111-8111-111111111111');
    expect(keys).toContain('age:adult');
  });

  it('画面表示用に名前・肩書き・側・年齢区分・役割を返す', () => {
    const result = seatGuestsFromBook(
      book([
        response('a', { people: [person('a-1', { seatRole: 'toast', ageCategory: 'child' })] }),
      ]),
    );
    expect(result.info['a-1']).toEqual({
      id: 'a-1',
      name: 'ゲストa-1',
      title: '新郎友人',
      side: 'groom',
      ageCategory: 'child',
      seatRole: 'toast',
    });
  });
});
