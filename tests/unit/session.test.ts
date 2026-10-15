import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Role } from '@/lib/constants';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  redirect: vi.fn((path: string): never => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

import {
  getAppUser,
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
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'verified-auth-id' } }, error: null });
  mocks.maybeSingle.mockResolvedValue({ data: profile(), error: null });
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
});

describe('検証済みセッションと有効プロフィールの境界', () => {
  it('未認証はプロフィールを検索しない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'expired' } });
    expect(await resolveAppUser()).toEqual({ state: 'anonymous' });
    expect(mocks.from).not.toHaveBeenCalled();
    await expect(requireAppUser()).rejects.toMatchObject({ status: 401 });
    expect(await getAppUser()).toBeNull();
    await expect(requirePageUser()).rejects.toThrow('REDIRECT:/login');
  });

  it.each(['invited', 'suspended', 'deleted'])(
    '%s は API 403・画面ログインに統一する',
    async (status) => {
      mocks.maybeSingle.mockResolvedValue({ data: { ...profile(), status }, error: null });
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
    mocks.maybeSingle.mockResolvedValue(response);
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
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith('user_profiles');
    expect(mocks.eq).toHaveBeenCalledWith('auth_user_id', 'verified-auth-id');
    expect(await getAppUser()).toEqual(user);
    expect(await requirePageUser()).toEqual(user);
    expect(await requirePageUser('planner', 'admin')).toEqual(user);
  });

  it.each(['planner', 'admin', 'system_admin'] as Role[])(
    '%s を staff として許可する',
    async (role) => {
      mocks.maybeSingle.mockResolvedValue({ data: profile(role), error: null });
      expect((await requireStaff()).role).toBe(role);
      expect((await requireRole(role)).role).toBe(role);
    },
  );

  it('couple は staff API を実行できない', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: profile('couple'), error: null });
    await expect(requireStaff()).rejects.toMatchObject({ status: 403 });
    await expect(requireRole('admin', 'system_admin')).rejects.toMatchObject({ status: 403 });
    await expect(requirePageUser('planner', 'admin')).rejects.toThrow('REDIRECT:/mypage');
  });

  it.each([
    ['couple', '/mypage'],
    ['planner', '/dashboard'],
    ['admin', '/dashboard'],
    ['system_admin', '/system'],
  ] as const)('%s の初期遷移先は %s', (role, path) => {
    expect(landingPathFor(role)).toBe(path);
  });
});
