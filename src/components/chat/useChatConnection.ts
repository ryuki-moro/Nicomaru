/** ChatConnection を React から使うためのフック。 */
'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { api, ApiCallError } from '@/lib/api/client';

import { ChatConnection, type ChatDeps, type SocketLike } from './chatConnection';
import type { MessageView } from './chatLogic';

const deps: ChatDeps = {
  api: {
    get: (path) => api.get(path),
    post: (path, body) => api.post(path, body),
    del: (path) => api.del(path),
  },
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  isVisible: () => document.visibilityState === 'visible',
  isUnavailable: (error) => error instanceof ApiCallError && error.body.code === 'CHAT_UNAVAILABLE',
};

export function useChatConnection(opts: {
  caseId: string;
  initialMessages: MessageView[];
  initialHasOlder: boolean;
  retractWindowMs: number;
}) {
  const { caseId, initialMessages, initialHasOlder, retractWindowMs } = opts;
  // 初期値は最初の1回だけ使う（以後の更新は接続側が持つ）
  const connection = useMemo(
    () =>
      new ChatConnection(
        caseId,
        { messages: initialMessages, hasOlder: initialHasOlder, retractWindowMs },
        deps,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [caseId],
  );
  const state = useSyncExternalStore(
    connection.subscribe,
    connection.getState,
    connection.getState,
  );

  useEffect(() => {
    connection.start();
    const onVisible = () => connection.onVisibilityChange();
    const onOnline = () => connection.onOnline();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      connection.stop();
    };
  }, [connection]);

  const send = useCallback(
    (body: string, refs?: { type: string; id: string }[]) => connection.send(body, refs),
    [connection],
  );
  const retract = useCallback((id: string) => connection.retract(id), [connection]);
  const loadOlder = useCallback(() => connection.loadOlder(), [connection]);
  const markTaskLinked = useCallback(
    (messageId: string, taskId: string) => connection.markTaskLinked(messageId, taskId),
    [connection],
  );

  return { ...state, send, retract, loadOlder, markTaskLinked };
}
