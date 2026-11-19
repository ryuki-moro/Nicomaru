import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Role } from '@/lib/constants';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  d1: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/d1/auth', () => ({ resolveD1User: mocks.d1 }));

import {
  getAppUser,
  landingLabelFor,
  landingPathFor,
  requireAppUser,
  requirePageUser,
  requireRole,
  requireStaff,
  resolveAppUser,
} from '@/lib/auth/session';

const profile = (role: Role = 'planner') => ({
  id: 'profile-id',
  auth_user_id: 'verified-auth-id',
  role,
  venue_id: 'venue-id',
  display_name: 'テスト担当',
  email: 'fixture@example.test',
  status: 'active',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NICOMARU_DB', '');
  mocks.d1.mockResolvedValue({
    state: 'active',
    user: {
      id: 'profile-id',
      authUserId: 'verified-auth-id',
      role: 'planner',
      venueId: 'venue-id',
      displayName: 'テスト担当',
      email: 'fixture@example.test',
    },
  });
  mocks.maybeSingle.mockResolvedValue({ data: profile(), error: null });
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
});
afterEach(() => vi.unstubAllEnvs());

describe('検証済みセッションと有効プロフィールの境界', () => {
  it('D1モードではD1の検証結果を使い、D1の結果をそのまま返す', async () => {
    vi.stubEnv('NICOMARU_DB', 'd1-local');
    const result = {
      state: 'active',
      user: { id: 'd1-user', role: 'planner', venueId: 'd1-venue' },
    };
    mocks.d1.mockResolvedValue(result);
    expect(await resolveAppUser()).toBe(result);
    expect(mocks.d1).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('未認証はプロフィールを検索しない', async () => {
    mocks.d1.mockResolvedValue({ state: 'anonymous' });
    expect(await resolveAppUser()).toEqual({ state: 'anonymous' });
    expect(mocks.from).not.toHaveBeenCalled();
    await expect(requireAppUser()).rejects.toMatchObject({ status: 401 });
    expect(await getAppUser()).toBeNull();
    await expect(requirePageUser()).rejects.toThrow('REDIRECT:/login');
  });

  it.each(['invited', 'suspended', 'deleted'])(
    '%s は API 403・画面ログインに統一する',
    async (status) => {
      mocks.d1.mockResolvedValue({ state: 'inactive' });
      expect(await resolveAppUser()).toEqual({ state: 'inactive' });
      await expect(requireAppUser()).rejects.toMatchObject({ status: 403 });
      expect(await getAppUser()).toBeNull();
      await expect(requirePageUser()).rejects.toThrow('REDIRECT:/login');
    },
  );

  it.each([
    { data: null, error: null },
    { data: profile(), error: { code: 'XX000' } },
  ])('プロフィール不在/検索失敗は権限を与えない (%j)', async (response) => {
    mocks.d1.mockResolvedValue({ state: 'inactive' });
    expect(await resolveAppUser()).toEqual({ state: 'inactive' });
  });

  it('JWT検証したユーザーIDだけを参照し、API判定は認証を1回だけ取得する', async () => {
    const user = await requireAppUser();
    expect(user).toEqual({
      id: 'profile-id',
      authUserId: 'verified-auth-id',
      role: 'planner',
      venueId: 'venue-id',
      displayName: 'テスト担当',
      email: 'fixture@example.test',
    });
    expect(mocks.d1).toHaveBeenCalledTimes(1);
    expect(await getAppUser()).toEqual(user);
    expect(await requirePageUser()).toEqual(user);
    expect(await requirePageUser('planner', 'admin')).toEqual(user);
  });

  it.each(['planner', 'admin', 'system_admin'] as Role[])(
    '%s を staff として許可する',
    async (role) => {
      mocks.d1.mockResolvedValue({ state: 'active', user: { role } });
      expect((await requireStaff()).role).toBe(role);
      expect((await requireRole(role)).role).toBe(role);
    },
  );

  it('couple は staff API を実行できない', async () => {
    mocks.d1.mockResolvedValue({ state: 'active', user: { role: 'couple' } });
    await expect(requireStaff()).rejects.toMatchObject({ status: 403 });
    await expect(requireRole('admin', 'system_admin')).rejects.toMatchObject({ status: 403 });
    await expect(requirePageUser('planner', 'admin')).rejects.toThrow('REDIRECT:/error?code=403');
  });

  it('staff どうしでもロールが足りなければ P04（403）へ送る', async () => {
    mocks.d1.mockResolvedValue({ state: 'active', user: { role: 'planner' } });
    await expect(requirePageUser('admin')).rejects.toThrow('REDIRECT:/error?code=403');
  });

  it.each([
    ['couple', '/mypage'],
    ['planner', '/cases'],
    ['admin', '/users'],
    ['system_admin', '/users'],
  ] as const)('%s の初期遷移先は %s', (role, path) => {
    expect(landingPathFor(role)).toBe(path);
  });

  it.each([
    ['couple', '/mypage', 'マイページ'],
    ['planner', '/cases', '案件一覧'],
    ['admin', '/users', 'プランナー管理'],
    ['system_admin', '/users', '職員管理'],
  ] as const)('D1版の %s は %s（%s）から始める', (role, path, label) => {
    vi.stubEnv('NICOMARU_DB', 'd1');
    try {
      expect([landingPathFor(role), landingLabelFor(role)]).toEqual([path, label]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['couple', 'マイページ'],
    ['planner', '案件一覧'],
    ['admin', 'プランナー管理'],
    ['system_admin', '職員管理'],
  ] as const)('%s の着地点の画面名は %s', (role, label) => {
    expect(landingLabelFor(role)).toBe(label);
  });
});
