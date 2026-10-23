import * as React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const m = vi.hoisted(() => ({
  admin: vi.fn(),
  server: vi.fn(),
  user: vi.fn(),
  redirect: vi.fn(),
  state: 'unused',
  owner: false,
  dbError: false,
  select: vi.fn(),
  eq: vi.fn(),
  ownEq: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ getAppUser: m.user }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: m.admin }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: m.server }));
vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('@/app/(public)/register/[token]/RegisterForm', () => ({
  RegisterForm: () => React.createElement('div', { 'data-testid': 'form' }, '登録フォーム'),
}));
import Page, { dynamic } from '@/app/(public)/register/[token]/page';
import { hashInvitationToken, invitationLanding } from '@/lib/services/invitations';
const token = 'A'.repeat(43);
beforeEach(() => {
  vi.resetAllMocks();
  m.state = 'unused';
  m.owner = false;
  m.dbError = false;
  m.user.mockResolvedValue(null);
  m.redirect.mockImplementation((url: string) => {
    throw new Error('REDIRECT:' + url);
  });
  const chain = {
    select: m.select.mockReturnThis(),
    eq: m.eq.mockReturnThis(),
    maybeSingle: vi.fn(async () => ({
      data:
        m.state === 'missing'
          ? null
          : {
              expires_at: m.state === 'expired' ? '2000-01-01' : '2099-01-01',
              used_at: m.state === 'used' ? '2026-10-15' : null,
              revoked_at: m.state === 'revoked' ? '2026-10-15' : null,
              use_count: m.state === 'used' ? 1 : 0,
              max_uses: 1,
              case_id: 'private-case',
              target_partner_role: 'bride',
            },
      error: m.dbError ? { message: 'private-db-error' } : null,
    })),
  };
  m.admin.mockReturnValue({ from: () => chain });
  const own = {
    select: vi.fn().mockReturnThis(),
    eq: m.ownEq.mockReturnThis(),
    maybeSingle: vi.fn(async () => ({
      data: m.owner ? { case_id: 'private-case', partner_role: 'bride' } : null,
      error: null,
    })),
  };
  m.server.mockResolvedValue({ from: () => own });
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function html(value = token) {
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ token: value }) }));
}
describe('招待状態表示', () => {
  it.each(['bad', 'A'.repeat(42), 'A'.repeat(44), '+'.repeat(43), ' '.repeat(43)])(
    '不正形式%sはDBを参照しない',
    async (value) => {
      expect(await html(value)).toContain('無効');
      expect(m.admin).not.toHaveBeenCalled();
    },
  );
  it('未使用はフォーム、DB照会は状態列のselectのみ', async () => {
    const result = await html();
    expect(result).toContain('登録フォーム');
    expect(result).not.toContain('private-case');
    expect(m.admin).toHaveBeenCalledWith('auth.invitation-peek');
    expect(m.eq).toHaveBeenCalledWith('purpose', 'initial_registration');
    expect(m.eq).toHaveBeenCalledWith('token_hash', hashInvitationToken(token));
    expect(m.eq).not.toHaveBeenCalledWith('token_hash', token);
    expect(dynamic).toBe('force-dynamic');
    expect(m.select).toHaveBeenCalledWith(
      'expires_at, used_at, revoked_at, use_count, max_uses, case_id, target_partner_role',
    );
  });
  it('使用済みで未ログインなら登録済み表示', async () => {
    m.state = 'used';
    const result = await html();
    expect(result).toContain('登録済み');
    expect(result).toContain('/login?next=/mypage');
    expect(result).not.toContain('登録フォーム');
  });
  it('使用済みの本人だけマイページへ', async () => {
    m.state = 'used';
    m.owner = true;
    m.user.mockResolvedValue({ id: 'u', role: 'couple', displayName: '本人' });
    await expect(html()).rejects.toThrow('REDIRECT:/mypage');
    expect(m.ownEq.mock.calls).toEqual([
      ['user_profile_id', 'u'],
      ['case_id', 'private-case'],
      ['partner_role', 'bride'],
    ]);
  });
  it.each(['同案件別パートナー', '別案件'])('%sは使用済みでもリダイレクトしない', async () => {
    m.state = 'used';
    m.user.mockResolvedValue({ id: 'other', role: 'couple', displayName: '別人' });
    expect(await html()).toContain('登録済み');
    expect(m.redirect).not.toHaveBeenCalled();
  });
  it('共用端末のパートナーAや紐付け前ログインでも未使用フォームを維持', async () => {
    m.user.mockResolvedValue({ id: 'a', role: 'couple', displayName: 'パートナーA' });
    const result = await html();
    expect(result).toContain('登録フォーム');
    expect(result).toContain('パートナーAとしてログイン中');
    expect(m.redirect).not.toHaveBeenCalled();
    expect(m.server).not.toHaveBeenCalled();
  });
  it('未使用なら本人でもフォームを維持し、所有関係を照会しない', async () => {
    m.owner = true;
    m.user.mockResolvedValue({ id: 'u', role: 'couple', displayName: '本人' });
    expect(await html()).toContain('登録フォーム');
    expect(m.server).not.toHaveBeenCalled();
    expect(m.redirect).not.toHaveBeenCalled();
  });
  it.each(['planner', 'admin', 'system_admin'])('%sは本人照会/リダイレクトしない', async (role) => {
    m.state = 'used';
    m.owner = true;
    m.user.mockResolvedValue({ id: 'staff', role, displayName: '担当' });
    expect(await html()).toContain('登録済み');
    expect(m.server).not.toHaveBeenCalled();
    expect(m.redirect).not.toHaveBeenCalled();
  });
  it.each(['expired', 'revoked', 'missing'])('%sは無効にまとめて表示', async (state) => {
    m.state = state;
    expect(await html()).toContain('有効期限が切れているか無効');
    expect(m.user).not.toHaveBeenCalled();
  });
  it('DB障害は登録済み/無効と誤判定せず再試行を案内', async () => {
    m.dbError = true;
    const result = await html();
    expect(result).toContain('確認できません');
    expect(result).not.toContain('private-db-error');
  });
  it.each([null, 'expired', 'revoked'] as const)('純粋判定で%sはinvalid', (state) =>
    expect(invitationLanding(state, true)).toBe('invalid'),
  );
});
