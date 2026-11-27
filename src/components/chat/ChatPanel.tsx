/** 案件チャットの本体（一覧・入力・接続状態・既読）。担当者と新郎新婦の画面で共通。 */
'use client';

import { useEffect, useState } from 'react';

import { api } from '@/lib/api/client';

import { ChatComposer } from './ChatComposer';
import { ChatThread } from './ChatThread';
import { CreateTaskDialog } from './CreateTaskDialog';
import { latestCursor, shouldMarkRead, type MessageView } from './chatLogic';
import { useChatConnection } from './useChatConnection';

const MARK_READ_DEBOUNCE_MS = 600;

interface Props {
  caseId: string;
  initialMessages: MessageView[];
  initialHasOlder: boolean;
  retractWindowMs: number;
  /** スタッフだけ true。メッセージから やること を作れる */
  canCreateTask?: boolean;
}

export function ChatPanel({
  caseId,
  initialMessages,
  initialHasOlder,
  retractWindowMs,
  canCreateTask = false,
}: Props) {
  const { messages, degraded, hasOlder, send, retract, loadOlder, markTaskLinked } =
    useChatConnection({
      caseId,
      initialMessages,
      initialHasOlder,
      retractWindowMs,
    });
  const [atBottom, setAtBottom] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const [lastMarked, setLastMarked] = useState<string | undefined>(undefined);
  const [taskSource, setTaskSource] = useState<MessageView | null>(null);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  // 新着が見えている間だけ、少し待ってから既読にする（描画のたびには送らない）
  const cursor = latestCursor(messages);
  const unread = shouldMarkRead(messages, lastMarked);
  useEffect(() => {
    if (!atBottom || !pageVisible || !unread || !cursor) return;
    const timer = setTimeout(() => {
      api
        .post(`/api/cases/${caseId}/messages/read`, { cursor })
        .then(() => setLastMarked(cursor))
        .catch(() => {
          // 既読は補助的な状態。失敗しても画面は止めず、次の新着でやり直す
        });
    }, MARK_READ_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [atBottom, pageVisible, unread, cursor, caseId]);

  return (
    <div>
      {degraded && (
        <p role="status" className="banner-info mb-2">
          自動更新が遅れています（30秒ごとに確認しています）
        </p>
      )}
      <ChatThread
        messages={messages}
        hasOlder={hasOlder}
        retractWindowMs={retractWindowMs}
        onLoadOlder={loadOlder}
        onRetract={retract}
        onAtBottomChange={setAtBottom}
        onCreateTask={canCreateTask ? setTaskSource : undefined}
      />
      <CreateTaskDialog
        message={taskSource}
        onClose={() => setTaskSource(null)}
        onCreated={markTaskLinked}
      />
      <ChatComposer caseId={caseId} onSend={send} />
    </div>
  );
}
