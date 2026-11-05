import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/crypto', () => ({
  normalizeEmail: (v: string) => v.trim().toLowerCase(),
  emailHash: (v: string) => 'hash:' + v,
  encryptPii: (v: string) => 'encrypted:' + v,
}));
import { saveInvitationRecipient } from '@/lib/services/invitation-recipient';
import { invitationIssueSchema, invitationSendSchema } from '@/lib/validation';
const partner = { partner_role: 'bride' as const, email: null, email_hash: null };
function client(options: { invitations?: unknown[]; saved?: unknown; lookupError?: unknown } = {}) {
  const lookup = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: options.invitations ?? [], error: options.lookupError ?? null }).then(
        resolve,
        reject,
      ),
  };
  const write = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({
      data:
        options.saved === undefined
          ? { email: 'encrypted:test@example.test', email_hash: 'hash:test@example.test' }
          : options.saved,
      error: null,
    })),
  };
  const db = { from: vi.fn((table: string) => (table === 'case_invitations' ? lookup : write)) };
  return { db: db as unknown as SupabaseClient, write, lookup };
}
describe('招待先メールの保存', () => {
  it('未登録相手へ正規化・暗号化してRLSセッションで条件付き保存', async () => {
    const c = client();
    expect(
      await saveInvitationRecipient(
        c.db,
        'case',
        'bride',
        partner,
        [partner],
        ' Test@Example.Test ',
      ),
    ).toEqual({ email: 'encrypted:test@example.test', email_hash: 'hash:test@example.test' });
    expect(c.write.update).toHaveBeenCalledWith({
      email: 'encrypted:test@example.test',
      email_hash: 'hash:test@example.test',
    });
    expect(c.write.eq).toHaveBeenCalledWith('case_id', 'case');
    expect(c.write.eq).toHaveBeenCalledWith('partner_role', 'bride');
    expect(c.write.is).toHaveBeenCalledWith('email', null);
  });
  it('登録済み宛先を上書きしない', async () => {
    const c = client();
    await expect(
      saveInvitationRecipient(
        c.db,
        'case',
        'bride',
        { ...partner, email: 'saved' },
        [partner],
        'test@example.test',
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(c.db.from).not.toHaveBeenCalled();
  });
  it('もう一方の保存済みアドレスと一致する場合は拒否', async () => {
    const c = client();
    await expect(
      saveInvitationRecipient(
        c.db,
        'case',
        'bride',
        partner,
        [partner, { partner_role: 'groom', email: 'saved', email_hash: 'hash:test@example.test' }],
        'test@example.test',
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(c.db.from).not.toHaveBeenCalled();
  });
  it('もう一方への有効な招待宛先と一致する場合は拒否', async () => {
    const c = client({
      invitations: [
        { expires_at: '2099-01-01', used_at: null, revoked_at: null, use_count: 0, max_uses: 1 },
      ],
    });
    await expect(
      saveInvitationRecipient(c.db, 'case', 'bride', partner, [partner], 'test@example.test'),
    ).rejects.toMatchObject({ status: 422 });
    expect(c.write.update).not.toHaveBeenCalled();
  });
  it('期限切れ招待は有効な重複と扱わない', async () => {
    const c = client({
      invitations: [
        { expires_at: '2000-01-01', used_at: null, revoked_at: null, use_count: 0, max_uses: 1 },
      ],
    });
    await expect(
      saveInvitationRecipient(c.db, 'case', 'bride', partner, [partner], 'test@example.test'),
    ).resolves.toHaveProperty('email');
  });
  it('同時更新で保存できなければ422', async () => {
    const c = client({ saved: null });
    await expect(
      saveInvitationRecipient(c.db, 'case', 'bride', partner, [partner], 'test@example.test'),
    ).rejects.toMatchObject({ status: 422 });
  });
  it('照会失敗では保存しない', async () => {
    const c = client({ lookupError: { code: '42501', message: 'private detail' } });
    await expect(
      saveInvitationRecipient(c.db, 'case', 'bride', partner, [partner], 'test@example.test'),
    ).rejects.toBeDefined();
    expect(c.write.update).not.toHaveBeenCalled();
  });
});
describe('招待APIの入力制約', () => {
  it('メール送信時にだけ宛先を指定できる', () => {
    expect(
      invitationIssueSchema.safeParse({
        targetPartnerRole: 'bride',
        send: 'email',
        recipientEmail: 'test@example.test',
      }).success,
    ).toBe(true);
    expect(
      invitationSendSchema.safeParse({ channel: 'email', recipientEmail: 'test@example.test' })
        .success,
    ).toBe(true);
  });
  it.each(['line', undefined])('発行時send=%sでは宛先指定を拒否', (send) =>
    expect(
      invitationIssueSchema.safeParse({
        targetPartnerRole: 'bride',
        send,
        recipientEmail: 'test@example.test',
      }).success,
    ).toBe(false),
  );
  it('LINE送信で宛先指定を拒否し、不正メールも拒否する', () => {
    expect(
      invitationSendSchema.safeParse({ channel: 'line', recipientEmail: 'test@example.test' })
        .success,
    ).toBe(false);
    expect(
      invitationSendSchema.safeParse({ channel: 'email', recipientEmail: 'bad' }).success,
    ).toBe(false);
  });
  it('宛先なしは従来入力を維持', () => {
    expect(invitationIssueSchema.safeParse({ targetPartnerRole: 'bride' }).success).toBe(true);
    expect(invitationSendSchema.safeParse({ channel: 'email' }).success).toBe(true);
  });
  it('LINE連携の終了後はlineを受け付けない', () => {
    expect(invitationSendSchema.safeParse({ channel: 'line' }).success).toBe(false);
    expect(
      invitationIssueSchema.safeParse({ targetPartnerRole: 'bride', send: 'line' }).success,
    ).toBe(false);
  });
});
