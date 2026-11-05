import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { calculateRisk, type RiskRule } from '@/lib/services/risk';
import { collectRiskInput } from '@/lib/services/riskStore';

const inactivity: RiskRule = {
  id: 'inactive',
  name: '無反応',
  conditionKey: 'no_activity_days',
  level: 'caution',
  scoreDelta: 20,
  priority: 20,
  params: { no_activity_days: 7 },
  description: null,
  active: true,
};

function client(
  login: string | null,
  submitted: string | null = null,
  followed: string | null = null,
) {
  const responses = [
    { id: 'case', venue_id: 'venue', wedding_date: '2027-01-01' },
    [
      {
        id: 'task',
        status: 'not_started',
        importance: 'normal',
        due_date: '2026-12-01',
        last_submitted_at: submitted,
      },
    ],
    followed ? { followed_at: followed } : null,
    [{ user_profile_id: 'groom' }, { user_profile_id: 'bride' }],
    login ? { last_login_at: login } : null,
  ];
  const inFilter = vi.fn();
  const from = vi.fn(() => {
    const result = Promise.resolve({ data: responses.shift(), error: null });
    const builder = Object.assign(result, {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockReturnThis(),
      in: (...args: unknown[]) => {
        inFilter(...args);
        return builder;
      },
    });
    return builder;
  });
  return { supabase: { from } as unknown as SupabaseClient, inFilter };
}

describe('ログイン時刻とリスク集計', () => {
  it('両パートナーの最新ログインを最終活動とし、無反応の理由を解除する', async () => {
    const { supabase, inFilter } = client('2026-10-15T02:00:00Z');
    const { input } = await collectRiskInput(supabase, 'case');
    expect(inFilter).toHaveBeenCalledWith('id', ['groom', 'bride']);
    expect(input.lastActivityAt).toBe('2026-10-15');
    expect(calculateRisk({ ...input, today: '2026-10-15' }, [inactivity]).reasons).toEqual([]);
  });

  it('活動がなければ無反応判定を維持する', async () => {
    const { input } = await collectRiskInput(client(null).supabase, 'case');
    expect(input.lastActivityAt).toBeNull();
    expect(
      calculateRisk({ ...input, today: '2026-10-15' }, [inactivity]).reasons[0].conditionKey,
    ).toBe('no_activity_days');
  });

  it('日本時間の日付で無反応日数を数え、UTCの日付で一日早く判定しない', async () => {
    const { input } = await collectRiskInput(client('2026-10-14T15:30:00Z').supabase, 'case');
    expect(input.lastActivityAt).toBe('2026-10-15');
    expect(calculateRisk({ ...input, today: '2026-10-21' }, [inactivity]).reasons).toEqual([]);
  });

  it('ログインより新しい提出・フォローがあればそちらを使う', async () => {
    const { input } = await collectRiskInput(
      client('2026-10-01T02:00:00Z', '2026-10-14T02:00:00Z', '2026-10-15T02:00:00Z').supabase,
      'case',
    );
    expect(input.lastActivityAt).toBe('2026-10-15');
  });
});
