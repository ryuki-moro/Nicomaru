import { chatService } from '@/lib/d1/runtime';
import { internalNotifyToken, type ChatSignal } from './ticket';

const TIMEOUT_MS = 3000;

/** service binding（Fetcher）のうち使う部分だけ。テストでは差し替える。 */
export interface ChatFetcher {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ): Promise<{ ok: boolean; status: number }>;
}

/**
 * チャットWorkerへ「新着あり」の合図を送る。失敗しても投稿・取り消し自体は成功させるため例外を投げない。
 * ログには本文・ID・応答内容を出さない。
 */
export async function sendChatSignal(
  signal: ChatSignal,
  deps: { fetcher?: ChatFetcher; secret?: string } = {},
): Promise<void> {
  try {
    const secret = deps.secret ?? process.env.CHAT_TICKET_SECRET;
    const fetcher = deps.fetcher ?? ((await chatService()) as unknown as ChatFetcher | undefined);
    if (!fetcher || !secret) return;
    const response = await fetcher.fetch('https://chat/notify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chat-internal-token': await internalNotifyToken(secret),
      },
      body: JSON.stringify(signal),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.warn('[chat] 通知に失敗しました', response.status);
  } catch (error) {
    console.warn('[chat] 通知に失敗しました', error instanceof Error ? error.name : 'unknown');
  }
}
