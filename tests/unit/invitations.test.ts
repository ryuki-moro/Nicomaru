/**
 * 6-3-6「招待トークンの保存方式」／6-6-1／13-1（有効期限の決定）を検証する。
 * 12-2 の「人手レビュー必須領域」に含まれるため、退行をテストで固定する。
 */
import { describe, expect, it } from 'vitest';

import { INVITATION_MAX_USES, INVITATION_TTL_DAYS } from '@/lib/constants';
import {
  buildInvitationUrl,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationMaxUses,
  invitationState,
  matchRecipientEmail,
  type InvitationRow,
} from '@/lib/services/invitations';

const NOW = new Date('2026-09-01T00:00:00Z');

const row = (over: Partial<InvitationRow> = {}): InvitationRow => ({
  expires_at: '2026-09-15T00:00:00Z',
  used_at: null,
  revoked_at: null,
  use_count: 0,
  max_uses: 1,
  ...over,
});

describe('トークンの生成とハッシュ', () => {
  it('毎回異なる推測困難な値を生成する', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(200);
  });

  it('256bit 相当の長さがある', () => {
    // base64url で 32 バイト = 43 文字
    expect(generateInvitationToken()).toHaveLength(43);
  });

  it('URL に安全な文字だけを含む', () => {
    expect(generateInvitationToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('ハッシュは決定的で、平文を復元できない形式（SHA-256 hex）', () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).toBe(hashInvitationToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('異なるトークンは異なるハッシュになる', () => {
    expect(hashInvitationToken('a')).not.toBe(hashInvitationToken('b'));
  });
});

describe('有効期限と使用回数（13-1 の決定）', () => {
  it('初回登録は14日・1回まで', () => {
    expect(INVITATION_TTL_DAYS.initial_registration).toBe(14);
    expect(invitationMaxUses('initial_registration')).toBe(1);
    expect(invitationExpiresAt('initial_registration', NOW).toISOString())
      .toBe('2026-09-15T00:00:00.000Z');
  });

  it('マイページ案内は30日・5回まで', () => {
    expect(INVITATION_TTL_DAYS.mypage_access).toBe(30);
    expect(INVITATION_MAX_USES.mypage_access).toBe(5);
    expect(invitationExpiresAt('mypage_access', NOW).toISOString())
      .toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('invitationState（K02 招待状況セクションの表示）', () => {
  it('未使用・期限内なら unused', () => {
    expect(invitationState(row(), NOW)).toBe('unused');
  });

  it('used_at があれば used', () => {
    expect(invitationState(row({ used_at: '2026-09-02T00:00:00Z' }), NOW)).toBe('used');
  });

  it('使用回数が上限に達していれば used', () => {
    expect(invitationState(row({ use_count: 5, max_uses: 5 }), NOW)).toBe('used');
  });

  it('期限切れなら expired', () => {
    expect(invitationState(row({ expires_at: '2026-08-31T23:59:59Z' }), NOW)).toBe('expired');
  });

  it('期限ちょうどは expired（境界値）', () => {
    expect(invitationState(row({ expires_at: NOW.toISOString() }), NOW)).toBe('expired');
  });

  it('revoked_at が最優先（再発行した古いトークン）', () => {
    const revoked = row({ revoked_at: '2026-09-01T00:00:00Z', used_at: '2026-09-01T00:00:00Z' });
    expect(invitationState(revoked, NOW)).toBe('revoked');
  });
});

describe('matchRecipientEmail（6-6-1 のメール照合）', () => {
  it('一致すれば match', () => {
    expect(matchRecipientEmail('abc', 'abc')).toBe('match');
  });

  it('不一致なら mismatch（招待URLを入手した第三者による登録を防ぐ）', () => {
    expect(matchRecipientEmail('abc', 'xyz')).toBe('mismatch');
  });

  it('recipient_email が無い招待（LINE案内）は確認コード検証を要する', () => {
    expect(matchRecipientEmail(null, 'abc')).toBe('requires_verification');
  });
});

describe('buildInvitationUrl', () => {
  it('末尾のスラッシュを重複させない', () => {
    expect(buildInvitationUrl('https://example.test/', 'TOKEN'))
      .toBe('https://example.test/register/TOKEN');
    expect(buildInvitationUrl('https://example.test', 'TOKEN'))
      .toBe('https://example.test/register/TOKEN');
  });
});
