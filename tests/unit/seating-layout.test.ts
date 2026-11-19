import { describe, expect, it } from 'vitest';

import {
  LAYOUT_TEMPLATES,
  applyRules,
  buildGrid,
  needsFrom,
  tableAccepts,
  totalSeats,
  type RuleGuest,
} from '@/lib/seating/layout';

const response = (overrides: Partial<RuleGuest> = {}): RuleGuest => ({
  attending: true,
  guestSide: 'groom',
  relationship: 'friend',
  people: 1,
  ...overrides,
});

describe('卓の配置テンプレート', () => {
  it('どのテンプレートも、卓が会場図の中に収まり、定員が2〜20名になる', () => {
    for (const templates of Object.values(LAYOUT_TEMPLATES)) {
      for (const template of templates) {
        const tables = template.make();
        expect(tables.length).toBeGreaterThan(0);
        for (const t of tables) {
          expect(t.x).toBeGreaterThan(0);
          expect(t.x).toBeLessThan(1);
          expect(t.y).toBeGreaterThan(0);
          expect(t.y).toBeLessThan(1);
          expect(t.capacity).toBeGreaterThanOrEqual(2);
          expect(t.capacity).toBeLessThanOrEqual(20);
        }
      }
    }
    expect(totalSeats(LAYOUT_TEMPLATES.wide[0].make())).toBe(64);
  });

  it('列 × 段で、等間隔に卓を並べる', () => {
    const tables = buildGrid('wide', 'round', 3, 2, 10);
    expect(tables).toHaveLength(6);
    expect(tables.map((t) => t.x).slice(0, 3)).toEqual([0.12, 0.5, 0.88]);
    expect(tables.map((t) => t.name)).toEqual(['1卓', '2卓', '3卓', '4卓', '5卓', '6卓']);
    expect(buildGrid('tall', 'rect', 1, 1, 8)[0]).toMatchObject({ x: 0.5, y: 0.56 });
  });
});

describe('出席人数の数え方', () => {
  it('出席の回答だけを、新郎新婦側と区分（職場・友人・親族）ごとに数える', () => {
    const needs = needsFrom([
      response({ relationship: 'colleague', people: 2 }),
      response({ relationship: 'teacher' }),
      response({ relationship: 'other' }),
      response({ guestSide: 'bride', relationship: 'family', people: 3 }),
      response({ attending: false, relationship: 'friend', people: 1 }),
      response({ guestSide: null }),
      response({ relationship: null }),
    ]);
    expect(needs).toEqual({ groom: [3, 1, 0], bride: [0, 0, 3] });
  });
});

describe('席次のルールで「座れる人」を振る', () => {
  it('高砂に近い卓から 職場 → 友人 → 親族 の順に、左を新郎側・右を新婦側にする', () => {
    // 横型 円卓8卓: 前の段 x=.16,.38 | .62,.84、後ろの段も同じ
    const tables = applyRules(LAYOUT_TEMPLATES.wide[0].make(), {
      groom: [8, 8, 8],
      bride: [8, 8, 8],
    });
    const byPos = (x: number, y: number) => tables.find((t) => t.x === x && t.y === y)!;
    // 前の段の中央寄りがいちばん上座
    expect(byPos(0.38, 0.4)).toMatchObject({
      name: '新郎職場1',
      allowedTags: ['side:groom', 'relationship:colleague', 'relationship:teacher'],
    });
    expect(byPos(0.62, 0.4).name).toBe('新婦職場1');
    expect(byPos(0.16, 0.4).name).toBe('新郎職場2');
    // 余った1卓は、1卓あたりの人数がいちばん多い区分（並びが先の職場）に足される
    expect(
      tables
        .filter((t) => t.allowedTags.includes('side:groom'))
        .map((t) => t.name)
        .sort(),
    ).toEqual(['新郎友人', '新郎職場1', '新郎職場2', '新郎親族'].sort());
  });

  it('人数の無い区分は飛ばし、卓が足りなければ人数の少ない区分を隣とまとめる', () => {
    // 新郎側に卓が2つだけ（くし型4本のうち左2本）
    const tables = applyRules(LAYOUT_TEMPLATES.wide[2].make(), {
      groom: [12, 2, 10],
      bride: [0, 12, 0],
    });
    const groom = tables.filter((t) => t.x < 0.5).sort((a, b) => b.x - a.x);
    // 友人（2名）がいちばん少なく、後ろの親族とまとまる（いちばん後ろの区分のときだけ前とまとめる）
    expect(groom.map((t) => t.name)).toEqual(['新郎職場', '新郎友人・親族']);
    expect(groom[1].allowedTags).toEqual([
      'side:groom',
      'relationship:friend',
      'relationship:other',
      'relationship:relative',
      'relationship:family',
    ]);
    // 新婦側は友人しかいないので、2本とも友人
    expect(
      tables
        .filter((t) => t.x > 0.5)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['新婦友人1', '新婦友人2']);
  });

  it('真ん中の列の卓は出席者の多い側に振り、卓の位置・形・定員は変えない', () => {
    const before = LAYOUT_TEMPLATES.wide[1].make(); // 5列。x=.5 が真ん中
    const after = applyRules(before, { groom: [1, 1, 1], bride: [10, 10, 10] });
    expect(after.filter((t) => t.x === 0.5).every((t) => t.allowedTags[0] === 'side:bride')).toBe(
      true,
    );
    expect(after.map(({ x, y, shape, capacity }) => ({ x, y, shape, capacity }))).toEqual(
      before.map(({ x, y, shape, capacity }) => ({ x, y, shape, capacity })),
    );
    // 元の配列は書き換えない
    expect(before.every((t) => t.allowedTags.length === 0)).toBe(true);
  });

  it('回答がまだ無くても、3区分を振る', () => {
    const tables = applyRules(LAYOUT_TEMPLATES.tall[0].make(), {
      groom: [0, 0, 0],
      bride: [0, 0, 0],
    });
    expect(new Set(tables.map((t) => t.name.replace(/\d$/, '')))).toEqual(
      new Set(['新郎職場', '新郎友人', '新郎親族', '新婦職場', '新婦友人', '新婦親族']),
    );
  });
});

describe('卓に座れる人の判定', () => {
  it('空ならだれでも、同じ種類は「または」、種類が違えば「かつ」', () => {
    const guest = ['side:groom', 'relationship:teacher', 'tag:abc'];
    expect(tableAccepts([], guest)).toBe(true);
    expect(
      tableAccepts(['side:groom', 'relationship:colleague', 'relationship:teacher'], guest),
    ).toBe(true);
    expect(tableAccepts(['side:bride', 'relationship:teacher'], guest)).toBe(false);
    expect(tableAccepts(['relationship:friend'], guest)).toBe(false);
    expect(tableAccepts(['side:groom', 'tag:abc'], guest)).toBe(true);
    expect(tableAccepts(['tag:xyz'], guest)).toBe(false);
  });
});
