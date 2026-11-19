import { describe, expect, it } from 'vitest';

import { seatingChartSaveSchema, seatingChartSubmitSchema } from '@/lib/validation';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('seatingChartSaveSchema', () => {
  it('配置・版・配置の割り当てを受け付ける', () => {
    expect(
      seatingChartSaveSchema.safeParse({
        layoutId: id(1),
        version: 0,
        assignments: [{ guestId: id(2), tableId: id(3) }],
      }).success,
    ).toBe(true);
    expect(
      seatingChartSaveSchema.safeParse({ layoutId: null, version: 3, assignments: [] }).success,
    ).toBe(true);
  });

  it('負の版・小数の版・uuid でない ID・余分な項目を拒否する', () => {
    const base = { layoutId: id(1), version: 0, assignments: [] };
    expect(seatingChartSaveSchema.safeParse({ ...base, version: -1 }).success).toBe(false);
    expect(seatingChartSaveSchema.safeParse({ ...base, version: 1.5 }).success).toBe(false);
    expect(seatingChartSaveSchema.safeParse({ ...base, layoutId: 'x' }).success).toBe(false);
    expect(
      seatingChartSaveSchema.safeParse({ ...base, assignments: [{ guestId: 'x', tableId: id(3) }] })
        .success,
    ).toBe(false);
    expect(seatingChartSaveSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('割り当ては500件まで', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, () => ({ guestId: id(2), tableId: id(3) }));
    const base = { layoutId: id(1), version: 0 };
    expect(seatingChartSaveSchema.safeParse({ ...base, assignments: rows(500) }).success).toBe(
      true,
    );
    expect(seatingChartSaveSchema.safeParse({ ...base, assignments: rows(501) }).success).toBe(
      false,
    );
  });
});

describe('seatingChartSubmitSchema', () => {
  it('版だけを受け付ける', () => {
    expect(seatingChartSubmitSchema.safeParse({ version: 2 }).success).toBe(true);
    expect(seatingChartSubmitSchema.safeParse({ version: -1 }).success).toBe(false);
    expect(seatingChartSubmitSchema.safeParse({ version: 2, extra: 1 }).success).toBe(false);
  });
});
