/**
 * チャット用 WebSocket チケット（短命・HMAC-SHA256）と、本体→チャットWorkerの通知トークン。
 * 本体（Node/Workers）とチャットWorkerで共有するため WebCrypto のみを使う。
 */

export const TICKET_TTL_SEC = 60;

export interface ChatTicket {
  caseId: string;
  userId: string;
  /** 有効期限（epoch 秒） */
  exp: number;
}

/** チャットWorkerが各ソケットへ流す「新着あり」の合図。本文は含めない。 */
export interface ChatSignal {
  type: 'message' | 'retract';
  caseId: string;
  cursor: string;
  senderUserId: string;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

async function hmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), data);
  return new Uint8Array(sig);
}

export async function signTicket(secret: string, t: ChatTicket): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(t)));
  const sig = await hmac(secret, encoder.encode(payload));
  return `${payload}.${toBase64Url(sig)}`;
}

/** 署名・期限・型を検証する。どれかが不正なら null。 */
export async function verifyTicket(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<ChatTicket | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sigPart] = parts;
  const sig = fromBase64Url(sigPart);
  const body = fromBase64Url(payload);
  if (!sig || !body) return null;
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    sig,
    encoder.encode(payload),
  );
  if (!ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { caseId, userId, exp } = parsed as Record<string, unknown>;
  if (typeof caseId !== 'string' || !caseId) return null;
  if (typeof userId !== 'string' || !userId) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSec) return null;
  return { caseId, userId, exp };
}

/** 本体→チャットWorkerの /notify 用の内部トークン。 */
export async function internalNotifyToken(secret: string): Promise<string> {
  return toBase64Url(await hmac(secret, encoder.encode('nicomaru-chat-notify')));
}
