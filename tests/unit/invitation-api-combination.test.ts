import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({
  role: vi.fn(),
  client: vi.fn(),
  send: vi.fn(),
  rpc: vi.fn(),
  d1Issue: vi.fn(),
  savedEmail: null as string | null,
  savedHash: null as string | null,
  otherHash: 'hash:other@example.test',
  activeDuplicate: false,
}));
vi.mock('@/lib/auth/session', () => ({ requireRole: m.role }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: m.client }));
vi.mock('@/lib/notify/send', () => ({ sendInvitation: m.send }));
vi.mock('@/lib/d1/runtime', () => ({ localDB: async () => ({}) }));
vi.mock('@/lib/d1/onboarding', () => ({ issueInvitation: m.d1Issue }));
vi.mock('@/lib/crypto', () => ({
  normalizeEmail: (v: string) => v.trim().toLowerCase(),
  emailHash: (v: string) => 'hash:' + v,
  encryptPii: (v: string) => 'enc:' + v,
  readPii: (v: string | null) => v?.replace(/^enc:/, '') ?? '',
}));
import { GET, POST as issue } from '@/app/api/cases/[caseId]/invitations/route';
import { POST as resend } from '@/app/api/cases/[caseId]/invitations/[invitationId]/send/route';
function request(body: unknown) {
  return new Request('https://app.test/api/cases/c/invitations', {
    method: 'POST',
    headers: { origin: 'https://app.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function context() {
  return { params: Promise.resolve({ caseId: 'c', invitationId: 'old' }) };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_BASE_URL', 'https://app.test');
  m.savedEmail = null;
  m.savedHash = null;
  m.otherHash = 'hash:other@example.test';
  m.activeDuplicate = false;
  m.role.mockResolvedValue({ id: 'staff' });
  m.send.mockResolvedValue({ delivered: true });
  m.d1Issue.mockResolvedValue({ id: 'd1' });
  m.rpc.mockImplementation(async (name: string) => ({
    data:
      name === 'mark_invitation_sent'
        ? '2026-10-15T00:00:00Z'
        : { id: 'new', expires_at: '2026-10-29T00:00:00Z', channel: 'email' },
    error: null,
  }));
  m.client.mockReturnValue({
    rpc: m.rpc,
    from: (table: string) => {
      let update: { email: string; email_hash: string } | null = null;
      const result = () => {
        if (table === 'wedding_cases')
          return {
            data: {
              id: 'c',
              case_code: 'CASE',
              contact_channel: 'email',
              couple_profiles: [
                {
                  partner_role: 'groom',
                  full_name: '新郎',
                  email: 'enc:other@example.test',
                  email_hash: m.otherHash,
                  user_profiles: null,
                },
                {
                  partner_role: 'bride',
                  full_name: '新婦',
                  email: m.savedEmail,
                  email_hash: m.savedHash,
                  user_profiles: null,
                },
              ],
            },
            error: null,
          };
        if (table === 'case_invitations')
          return {
            data: { id: 'old', target_partner_role: 'bride', purpose: 'initial_registration' },
            error: null,
          };
        if (table === 'couple_profiles' && update) {
          m.savedEmail = update.email;
          m.savedHash = update.email_hash;
          return { data: update, error: null };
        }
        throw new Error(table);
      };
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        update: vi.fn((value) => {
          update = value;
          return chain;
        }),
        maybeSingle: vi.fn(async () => result()),
        then: (resolve: (value: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve({
            data: m.activeDuplicate
              ? [
                  {
                    expires_at: '2099-01-01',
                    used_at: null,
                    revoked_at: null,
                    use_count: 0,
                    max_uses: 1,
                  },
                ]
              : [],
            error: null,
          }).then(resolve, reject),
      };
      return chain;
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe.each([
  ['発行', issue],
  ['再送', resend],
] as const)('招待%sAPIの組合せ', (_name, post) => {
  const payload = (email?: string) =>
    post === issue
      ? { targetPartnerRole: 'bride', send: 'email', ...(email ? { recipientEmail: email } : {}) }
      : { channel: 'email', ...(email ? { recipientEmail: email } : {}) };
  it('未登録相手の宛先を保存し、その暗号文/HMACで再発行して送信する', async () => {
    const r = await post(request(payload('bride@example.test')), context());
    expect(r.status).toBe(post === issue ? 201 : 200);
    expect(m.savedEmail).toBe('enc:bride@example.test');
    expect(m.rpc).toHaveBeenCalledWith(
      'reissue_case_invitation',
      expect.objectContaining({
        p_recipient_email_enc: 'enc:bride@example.test',
        p_recipient_email_hash: 'hash:bride@example.test',
      }),
    );
    expect(m.send).toHaveBeenCalledWith(
      'email',
      { email: 'bride@example.test' },
      expect.objectContaining({
        invitationUrl: expect.stringMatching(/^https:\/\/app.test\/register\//),
      }),
    );
    expect(m.rpc).toHaveBeenCalledWith('mark_invitation_sent', expect.anything());
  });
  it('2回目は宛先入力なしでも保存した宛先を引き継ぐ', async () => {
    await post(request(payload('bride@example.test')), context());
    m.rpc.mockClear();
    m.send.mockClear();
    const r = await post(request(payload()), context());
    expect(r.status).toBe(post === issue ? 201 : 200);
    expect(m.rpc).toHaveBeenCalledWith(
      'reissue_case_invitation',
      expect.objectContaining({ p_recipient_email_hash: 'hash:bride@example.test' }),
    );
    expect(m.send.mock.calls[0][1].email).toBe('bride@example.test');
  });
  it('保存済み宛先は上書きせず422', async () => {
    m.savedEmail = 'enc:saved@example.test';
    m.savedHash = 'hash:saved@example.test';
    expect((await post(request(payload('new@example.test')), context())).status).toBe(422);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.d1Issue).not.toHaveBeenCalled();
  });
  it('宛先保存後に発行が失敗しても同じ宛先で再試行できる', async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000' } });
    expect((await post(request(payload('bride@example.test')), context())).status).toBe(500);
    expect(m.savedEmail).toBe('enc:bride@example.test');
    const retry = await post(request(payload('BRIDE@example.test')), context());
    expect(retry.status).toBe(post === issue ? 201 : 200);
    expect(m.send.mock.calls[0][1].email).toBe('bride@example.test');
  });
  it('外部送信が失敗しても同じ入力で再送でき、失敗時は送信済みにしない', async () => {
    m.send.mockRejectedValueOnce(new Error('test transport failure'));
    expect((await post(request(payload('bride@example.test')), context())).status).toBe(500);
    expect(m.rpc).not.toHaveBeenCalledWith('mark_invitation_sent', expect.anything());
    expect((await post(request(payload('bride@example.test')), context())).status).toBe(
      post === issue ? 201 : 200,
    );
    expect(m.rpc).toHaveBeenCalledWith('mark_invitation_sent', expect.anything());
  });
  it('もう一方の保存済み宛先と同じなら422', async () => {
    expect((await post(request(payload('other@example.test')), context())).status).toBe(422);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('もう一方の有効招待と同じなら422', async () => {
    m.activeDuplicate = true;
    expect((await post(request(payload('bride@example.test')), context())).status).toBe(422);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('宛先未指定なら既存の未登録送信処理へ渡し結果を返す', async () => {
    m.send.mockResolvedValue({ delivered: false, skippedReason: '送信先が未登録' });
    const r = await post(request(payload()), context());
    expect((await r.json()).delivered).toBe(false);
    expect(m.send.mock.calls[0][1].email).toBeNull();
    expect(m.rpc).not.toHaveBeenCalledWith('mark_invitation_sent', expect.anything());
  });
  it('LINEとの併用は400でDB/送信前に拒否', async () => {
    const p =
      post === issue
        ? { targetPartnerRole: 'bride', send: 'line', recipientEmail: 'bride@example.test' }
        : { channel: 'line', recipientEmail: 'bride@example.test' };
    expect((await post(request(p), context())).status).toBe(400);
    expect(m.client).not.toHaveBeenCalled();
  });
  it('D1ローカルへ入力した宛先を渡す', async () => {
    vi.stubEnv('NICOMARU_DB', 'd1-local');
    expect((await post(request(payload('bride@example.test')), context())).status).toBe(
      post === issue ? 201 : 200,
    );
    expect(m.client).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    expect(m.d1Issue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'c',
      'bride',
      'email',
      post === issue ? undefined : 'old',
      'bride@example.test',
    );
  });
});

it('招待一覧は宛先の有無だけ返し、メールやHMACを返さない', async () => {
  m.client.mockReturnValue({
    from: (table: string) => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            error: null,
            data:
              table === 'case_invitations'
                ? [
                    {
                      id: 'old',
                      target_partner_role: 'bride',
                      channel: 'email',
                      created_at: '2026-10-23',
                      expires_at: '2099-01-01',
                      sent_at: null,
                      used_at: null,
                      revoked_at: null,
                      use_count: 0,
                      max_uses: 1,
                    },
                  ]
                : [{ partner_role: 'bride', email: 'private-cipher', email_hash: 'private-hash' }],
          }).then(resolve),
      };
      return chain;
    },
  });
  const response = await GET(new Request('https://app.test/api/cases/c/invitations'), context());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.invitations[0].hasEmail).toBe(true);
  expect(JSON.stringify(body)).not.toMatch(/private|email_hash/);
});
