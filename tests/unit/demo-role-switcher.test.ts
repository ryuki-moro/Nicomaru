import { afterEach, describe, expect, it, vi } from 'vitest';

import { DemoRoleSwitcher } from '@/components/layout/DemoRoleSwitcher';

afterEach(() => vi.unstubAllEnvs());

describe('DemoRoleSwitcher', () => {
  it.each([
    ['d1-local', 'false'],
    ['d1', 'true'],
    ['d1', 'false'],
  ])('NEXT_PUBLIC_NICOMARU_DB=%s・DEMO_LOGIN=%s では何も描画しない', (db, demo) => {
    vi.stubEnv('NEXT_PUBLIC_NICOMARU_DB', db);
    vi.stubEnv('NEXT_PUBLIC_NICOMARU_DEMO_LOGIN', demo);
    expect(DemoRoleSwitcher({ role: 'planner' })).toBeNull();
  });

  it('デモのときだけ描画する', () => {
    vi.stubEnv('NEXT_PUBLIC_NICOMARU_DB', 'd1-local');
    vi.stubEnv('NEXT_PUBLIC_NICOMARU_DEMO_LOGIN', 'true');
    expect(DemoRoleSwitcher({ role: 'planner' })).not.toBeNull();
  });
});
