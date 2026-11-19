/**
 * 卓の配置パターン（#180）の入力検証（API の zod スキーマ）。
 */
import { describe, expect, it } from 'vitest';

import { seatingLayoutOfferSchema, seatingLayoutSchema } from '@/lib/validation';

const table = (overrides: Record<string, unknown> = {}) => ({
  name: ' 1卓 ',
  capacity: 8,
  shape: 'round',
  x: 0.3,
  y: 0.5,
  allowedTags: ['side:groom', 'relationship:friend'],
  ...overrides,
});
const layout = (overrides: Record<string, unknown> = {}) => ({
  name: '円卓ちらし型',
  hallShape: 'wide',
  tables: [table()],
  ...overrides,
});

describe('seatingLayoutSchema', () => {
  it('正常な内容を受け付け、名前の前後の空白を除く', () => {
    const parsed = seatingLayoutSchema.safeParse(layout());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.tables[0].name).toBe('1卓');
  });

  it('保存済みの卓の id と、自由タグ・アレルギーのキーを受け付ける', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const parsed = seatingLayoutSchema.safeParse(
      layout({ tables: [table({ id, allowedTags: ['allergy', `tag:${id}`, 'age:adult'] })] }),
    );
    expect(parsed.success).toBe(true);
  });

  it('定員は2〜20の整数', () => {
    expect(
      seatingLayoutSchema.safeParse(layout({ tables: [table({ capacity: 21 })] })).success,
    ).toBe(false);
    expect(
      seatingLayoutSchema.safeParse(layout({ tables: [table({ capacity: 1 })] })).success,
    ).toBe(false);
    expect(
      seatingLayoutSchema.safeParse(layout({ tables: [table({ capacity: 7.5 })] })).success,
    ).toBe(false);
    expect(
      seatingLayoutSchema.safeParse(layout({ tables: [table({ capacity: 20 })] })).success,
    ).toBe(true);
  });

  it('座れる人のキーの形が正しくなければ拒否する', () => {
    for (const bad of ['side:Groom', 'unknown:x', 'tag:xyz', 'allergy:x', 'side:', '']) {
      expect(
        seatingLayoutSchema.safeParse(layout({ tables: [table({ allowedTags: [bad] })] })).success,
        bad,
      ).toBe(false);
    }
  });

  it('卓は1〜26卓', () => {
    expect(seatingLayoutSchema.safeParse(layout({ tables: [] })).success).toBe(false);
    expect(
      seatingLayoutSchema.safeParse(layout({ tables: Array.from({ length: 26 }, () => table()) }))
        .success,
    ).toBe(true);
    expect(
      seatingLayoutSchema.safeParse(layout({ tables: Array.from({ length: 27 }, () => table()) }))
        .success,
    ).toBe(false);
  });

  it('名前・会場の形・位置・余計な項目を検査する', () => {
    expect(seatingLayoutSchema.safeParse(layout({ name: '  ' })).success).toBe(false);
    expect(seatingLayoutSchema.safeParse(layout({ name: 'あ'.repeat(31) })).success).toBe(false);
    expect(seatingLayoutSchema.safeParse(layout({ hallShape: 'round' })).success).toBe(false);
    expect(seatingLayoutSchema.safeParse(layout({ tables: [table({ x: 1.2 })] })).success).toBe(
      false,
    );
    expect(
      seatingLayoutSchema.safeParse(layout({ tables: [table({ name: 'あ'.repeat(21) })] })).success,
    ).toBe(false);
    expect(seatingLayoutSchema.safeParse(layout({ extra: 1 })).success).toBe(false);
  });
});

describe('seatingLayoutOfferSchema', () => {
  it('offered だけを受け付ける', () => {
    expect(seatingLayoutOfferSchema.safeParse({ offered: true }).success).toBe(true);
    expect(seatingLayoutOfferSchema.safeParse({ offered: 'yes' }).success).toBe(false);
    expect(seatingLayoutOfferSchema.safeParse({ offered: true, name: 'x' }).success).toBe(false);
  });
});
