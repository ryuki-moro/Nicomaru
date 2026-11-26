import { describe, expect, it } from 'vitest';

import { internalNotifyToken, signTicket, TICKET_TTL_SEC, verifyTicket } from '@/lib/chat/ticket';

const SECRET = 'test-secret-0123456789abcdef';
const NOW = 1_800_000_000;
const ticket = { caseId: 'case-1', userId: 'user-1', exp: NOW + TICKET_TTL_SEC };

describe('チャットチケット', () => {
  it('署名して検証すると同じ内容が返る', async () => {
    const token = await signTicket(SECRET, ticket);
    expect(await verifyTicket(SECRET, token, NOW)).toEqual(ticket);
  });

  it('期限切れは拒否する（exp ちょうども拒否）', async () => {
    const token = await signTicket(SECRET, ticket);
    expect(await verifyTicket(SECRET, token, ticket.exp)).toBeNull();
    expect(await verifyTicket(SECRET, token, ticket.exp + 1)).toBeNull();
  });

  it('本文を改ざんすると拒否する', async () => {
    const token = await signTicket(SECRET, ticket);
    const forged = btoa(JSON.stringify({ ...ticket, userId: 'user-2' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyTicket(SECRET, `${forged}.${token.split('.')[1]}`, NOW)).toBeNull();
  });

  it('署名を改ざんすると拒否する', async () => {
    const [payload, sig] = (await signTicket(SECRET, ticket)).split('.');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await verifyTicket(SECRET, `${payload}.${flipped}`, NOW)).toBeNull();
  });

  it('壊れた形式は拒否する', async () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', 'a.', '.b', '!!.??']) {
      expect(await verifyTicket(SECRET, bad, NOW)).toBeNull();
    }
  });

  it('別の秘密値では拒否する', async () => {
    const token = await signTicket(SECRET, ticket);
    expect(await verifyTicket('other-secret', token, NOW)).toBeNull();
  });

  it('型が違う本文は署名が正しくても拒否する', async () => {
    const bad = { caseId: 1, userId: 'u', exp: NOW + 10 } as unknown as typeof ticket;
    expect(await verifyTicket(SECRET, await signTicket(SECRET, bad), NOW)).toBeNull();
    const noExp = { caseId: 'c', userId: 'u', exp: '9999999999' } as unknown as typeof ticket;
    expect(await verifyTicket(SECRET, await signTicket(SECRET, noExp), NOW)).toBeNull();
  });

  it('内部通知トークンは同じ秘密値で安定し、秘密値が違えば変わる', async () => {
    const a = await internalNotifyToken(SECRET);
    expect(a).toBe(await internalNotifyToken(SECRET));
    expect(a).not.toBe(await internalNotifyToken('other-secret'));
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
