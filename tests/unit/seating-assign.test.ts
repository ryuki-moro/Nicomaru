import { describe, expect, it } from 'vitest';

import {
  autoAssign,
  canSubmit,
  checkSeating,
  moveInTable,
  placeGuest,
  placementWish,
  childGroupsOf,
  unplaceGuest,
  type SeatGuest,
  type SeatTable,
} from '@/lib/seating/assign';

const guest = (id: string, overrides: Partial<SeatGuest> = {}): SeatGuest => ({
  id,
  groupId: id,
  side: 'groom',
  ageCategory: 'adult',
  assistanceNeeds: [],
  seatRole: null,
  tagKeys: ['side:groom', 'relationship:friend'],
  ...overrides,
});

const table = (id: string, overrides: Partial<SeatTable> = {}): SeatTable => ({
  id,
  name: `${id}卓`,
  capacity: 4,
  x: 0.3,
  y: 0.4,
  allowedTags: [],
  ...overrides,
});

/** 決まった並びの乱数（テストで結果を固定する） */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('席の希望', () => {
  it('主賓・乾杯と耳・目は前、子ども連れと足腰・車いす・妊娠中は後ろ', () => {
    const family = [
      guest('p', { groupId: 'f' }),
      guest('c', { groupId: 'f', ageCategory: 'child' }),
    ];
    const kids = childGroupsOf(family);
    expect(placementWish(guest('a', { seatRole: 'chief' }), kids)).toMatchObject({
      where: 'front',
      role: true,
      reason: '主賓',
    });
    expect(placementWish(family[0], kids)).toMatchObject({ where: 'rear', reason: '子ども連れ' });
    expect(placementWish(family[1], kids)).toMatchObject({ where: 'rear', reason: '子ども' });
    expect(placementWish(guest('w', { assistanceNeeds: ['wheelchair'] }), kids)).toMatchObject({
      where: 'rear',
    });
    expect(placementWish(guest('h', { assistanceNeeds: ['hearing'] }), kids)).toMatchObject({
      where: 'front',
    });
    expect(placementWish(guest('n', { assistanceNeeds: ['other'] }), kids)).toBeNull();
  });
});

describe('1人ずつ入れる', () => {
  const tables = [table('A', { capacity: 3 }), table('B', { allowedTags: ['side:bride'] })];

  it('まだ席の無い家族・同伴者も一緒に入れ、主賓を先頭に並べる', () => {
    const guests = [
      guest('g1'),
      guest('p', { groupId: 'f' }),
      guest('c', { groupId: 'f', ageCategory: 'child' }),
      guest('chief', { seatRole: 'chief' }),
    ];
    let s = placeGuest({}, tables, guests, 'g1', 'A').seating;
    const r = placeGuest(s, tables, guests, 'p', 'A');
    expect(r.placed).toEqual(['p', 'c']);
    s = r.seating;
    expect(s.A).toEqual(['g1', 'p', 'c']);
    // 満席
    expect(placeGuest(s, tables, guests, 'chief', 'A').error).toBe('A卓は満席です');
    s = unplaceGuest(s, 'g1');
    s = placeGuest(s, tables, guests, 'chief', 'A').seating;
    expect(s.A).toEqual(['chief', 'p', 'c']);
  });

  it('条件に合わない卓には入れず、家族が入りきらないときは選んだ人だけ入れて知らせる', () => {
    const guests = [guest('p', { groupId: 'f' }), guest('c', { groupId: 'f' }), guest('x')];
    expect(placeGuest({}, tables, guests, 'p', 'B').error).toContain('座れる卓ではありません');
    const s = placeGuest({}, tables, guests, 'x', 'A').seating;
    const small = [table('A', { capacity: 2 })];
    const r = placeGuest(s, small, guests, 'p', 'A');
    expect(r.placed).toEqual(['p']);
    expect(r.note).toContain('空きが足りない');
  });

  it('席順を入れ替える', () => {
    const s = { A: ['a', 'b', 'c'] };
    expect(moveInTable(s, 'b', -1).A).toEqual(['b', 'a', 'c']);
    expect(moveInTable(s, 'c', 1).A).toEqual(['a', 'b', 'c']);
    expect(s.A).toEqual(['a', 'b', 'c']);
  });
});

describe('ランダムに配置する', () => {
  // 前の列（y=.3）と後ろの列（y=.8）、左右に1卓ずつ
  const tables = [
    table('FL', { x: 0.3, y: 0.3 }),
    table('FR', { x: 0.7, y: 0.3 }),
    table('RL', { x: 0.3, y: 0.8 }),
    table('RR', { x: 0.7, y: 0.8 }),
  ];

  it('決めた席は動かさず、未配置の人だけを入れる', () => {
    const guests = [guest('a'), guest('b'), guest('c')];
    const r = autoAssign({ RR: ['a'] }, tables, guests, seq(0.1, 0.6, 0.3));
    expect(r.seating.RR[0]).toBe('a');
    expect(r.placed.sort()).toEqual(['b', 'c']);
    expect(r.fails).toEqual([]);
  });

  it('主賓は前の列の中央寄り、車いすと子ども連れは後ろの列の入口（左）寄りに入る', () => {
    const guests = [
      guest('chief', { seatRole: 'chief' }),
      guest('w', { assistanceNeeds: ['wheelchair'] }),
      guest('p', { groupId: 'f' }),
      guest('c', { groupId: 'f', ageCategory: 'infant' }),
    ];
    const r = autoAssign({}, [...tables, table('FC', { x: 0.5, y: 0.3 })], guests, seq(0.5));
    expect(r.seating.FC).toEqual(['chief']);
    expect(r.seating.RL.sort()).toEqual(['c', 'p', 'w']);
    expect(r.wishes.map((w) => w.guestId).sort()).toEqual(['c', 'chief', 'p', 'w']);
  });

  it('後ろの卓が満席なら、その理由を添えて前へ入れる', () => {
    const guests = [guest('w', { assistanceNeeds: ['mobility'] })];
    const small = [table('F', { y: 0.3 }), table('R', { y: 0.8, capacity: 1 })];
    const r = autoAssign({ R: ['someone'] }, small, guests, seq(0.5));
    expect(r.seating.F).toEqual(['w']);
    expect(r.wishes[0].note).toBe('条件に合う後ろの卓が満席のため、この卓にしました');
  });

  it('条件に合う卓が無い・満席の人は理由を付けて残す', () => {
    const guests = [
      guest('bride', { side: 'bride', tagKeys: ['side:bride'] }),
      guest('none', { tagKeys: ['side:groom', 'relationship:teacher'] }),
      guest('full', { side: 'bride', tagKeys: ['side:bride'] }),
    ];
    const two = [
      table('G', { allowedTags: ['relationship:friend'], capacity: 4 }),
      table('B', { allowedTags: ['side:bride'], capacity: 1 }),
    ];
    const r = autoAssign({}, two, guests, seq(0));
    expect(r.seating.B).toHaveLength(1);
    expect(r.fails).toHaveLength(2);
    expect(r.fails).toEqual(
      expect.arrayContaining([
        { guestId: 'none', reason: '座れる条件の卓がありません' },
        expect.objectContaining({ reason: '条件に合う卓が満席です' }),
      ]),
    );
  });

  it('希望の無い人は、反対側（新郎側／新婦側）の人がいない卓を選ぶ', () => {
    const guests = [guest('g')];
    const two = [table('MIX', { capacity: 4 }), table('OK', { capacity: 4 })];
    const brideGuest = guest('b', { side: 'bride' });
    // 乱数が MIX を指しても、新婦側のいない OK を選ぶ
    const r = autoAssign({ MIX: ['b'] }, two, [brideGuest, ...guests], seq(0));
    expect(r.seating.OK).toEqual(['g']);
  });
});

describe('提出前の確かめ', () => {
  it('未配置・定員超過・条件に合わない席があれば提出できない', () => {
    const tables = [table('A', { capacity: 1, allowedTags: ['side:bride'] })];
    const guests = [guest('a'), guest('b')];
    const c = checkSeating({ A: ['a', 'b'] }, tables, guests);
    expect(c).toMatchObject({ unplaced: [], overTables: ['A'], mismatched: ['a', 'b'] });
    expect(canSubmit(c)).toBe(false);
    const ok = checkSeating({ A: ['a'] }, [table('A')], [guest('a')]);
    expect(canSubmit(ok)).toBe(true);
    expect(checkSeating({}, [table('A')], [guest('a')]).unplaced).toEqual(['a']);
  });
});
