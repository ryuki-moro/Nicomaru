import { describe, expect, it } from 'vitest';

import { chatMessageSchema } from '@/lib/validation';

describe('chatMessageSchema', () => {
  const ref = (n: number) => ({ type: 'task' as const, id: `task-${n}` });

  it('本文だけ・添付だけ・両方を受け付け、どちらも空は拒否する', () => {
    expect(chatMessageSchema.safeParse({ body: ' こんにちは ' }).data).toEqual({
      body: 'こんにちは',
      refs: [],
    });
    expect(chatMessageSchema.safeParse({ refs: [ref(1)] }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ body: 'a', refs: [ref(1)] }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({}).success).toBe(false);
  });

  it('添付は3件まで、種類は task・guest・seating だけ', () => {
    expect(chatMessageSchema.safeParse({ refs: [1, 2, 3].map(ref) }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ refs: [1, 2, 3, 4].map(ref) }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ refs: [{ type: 'file', id: 'x' }] }).success).toBe(false);
  });
});
