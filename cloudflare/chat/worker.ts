/**
 * チャットの「新着の合図」だけを中継する WebSocket Worker（本文・個人情報は扱わない）。
 * 本文はクライアントが既存のHTTP APIで取得する。接続は本体が発行した短命チケットで認可する。
 */
import { DurableObject } from 'cloudflare:workers';

import { internalNotifyToken, verifyTicket, type ChatSignal } from '../../src/lib/chat/ticket';

interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  CHAT_TICKET_SECRET: string;
  APP_BASE_URL: string;
}

const MAX_SOCKETS_PER_ROOM = 20;

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function parseSignal(value: unknown): ChatSignal | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, caseId, cursor, senderUserId } = value as Record<string, unknown>;
  if (type !== 'message' && type !== 'retract') return null;
  if (typeof caseId !== 'string' || !caseId) return null;
  if (typeof cursor !== 'string' || typeof senderUserId !== 'string') return null;
  return { type, caseId, cursor, senderUserId };
}

async function handleWs(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  if (request.headers.get('Origin') !== env.APP_BASE_URL) {
    return new Response('Forbidden', { status: 403 });
  }
  const ticket = new URL(request.url).searchParams.get('ticket');
  const claims = ticket ? await verifyTicket(env.CHAT_TICKET_SECRET, ticket) : null;
  if (!claims) return new Response('Unauthorized', { status: 401 });

  const headers = new Headers(request.headers);
  headers.set('x-chat-user', claims.userId);
  return env.CHAT_ROOM.getByName(claims.caseId).fetch(new Request(request, { headers }));
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  const given = request.headers.get('x-chat-internal-token') ?? '';
  const expected = await internalNotifyToken(env.CHAT_TICKET_SECRET);
  if (!safeEqual(given, expected)) return new Response('Unauthorized', { status: 401 });

  let signal: ChatSignal | null = null;
  try {
    signal = parseSignal(await request.json());
  } catch {
    // 不正なJSONは下で400にする
  }
  if (!signal) return new Response('Bad Request', { status: 400 });

  await env.CHAT_ROOM.getByName(signal.caseId).broadcast(signal);
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/ws' && request.method === 'GET') return handleWs(request, env);
    if (pathname === '/notify' && request.method === 'POST') return handleNotify(request, env);
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** 案件ごとの部屋。Hibernation API を使い、保存領域は使わない。 */
export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return new Response('Too Many Connections', { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId: request.headers.get('x-chat-user') ?? '' });
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(signal: ChatSignal): void {
    const message = JSON.stringify(signal);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // 切れたソケットは無視する
      }
    }
  }

  webSocketMessage(): void {}

  webSocketClose(ws: WebSocket, code: number): void {
    this.closeQuietly(ws, code);
  }

  webSocketError(ws: WebSocket): void {
    this.closeQuietly(ws, 1011);
  }

  private closeQuietly(ws: WebSocket, code: number): void {
    try {
      // 1005/1006 などの予約コードは close に渡せない
      ws.close(code >= 1000 && code <= 4999 && ![1005, 1006, 1015].includes(code) ? code : 1000);
    } catch {
      // 既に閉じている
    }
  }
}
