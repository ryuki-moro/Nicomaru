/**
 * チャットの発言一覧。古いものが上、新しいものが下。
 * 本文は文字列のまま描画する（HTML として解釈せず、リンクにもしない）。
 */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { EmptyState } from '@/components/ui/EmptyState';

import {
  canRetract,
  dayKeyJst,
  formatDayLabel,
  formatTimeJst,
  shouldAutoScroll,
} from './chatLogic';
import type { MessageView } from './chatLogic';

const SIDE_LABEL = { staff: '担当者', couple: '新郎新婦' } as const;

interface Props {
  messages: MessageView[];
  hasOlder: boolean;
  retractWindowMs: number;
  onLoadOlder: () => Promise<void>;
  onRetract: (id: string) => Promise<void>;
  /** 下端まで読んでいるかが変わったとき（既読の判定に使う） */
  onAtBottomChange?: (atBottom: boolean) => void;
}

export function ChatThread({
  messages,
  hasOlder,
  retractWindowMs,
  onLoadOlder,
  onRetract,
  onAtBottomChange,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previous = useRef<{ first?: string; last?: string; height: number } | null>(null);
  const [newBelow, setNewBelow] = useState(false);
  const [initialLastId] = useState(() => messages.at(-1)?.id);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 取り消せる時間が過ぎたらボタンを消すため、時計だけ進める
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const updateNearBottom = (value: boolean) => {
    if (nearBottom.current === value) return;
    nearBottom.current = value;
    onAtBottomChange?.(value);
    if (value) setNewBelow(false);
  };

  // 追加された位置で動きを変える: 末尾への追加は下端付近なら追従、先頭への追加は見ている位置を保つ
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const first = messages[0]?.id;
    const lastMessage = messages.at(-1);
    const last = lastMessage?.id;
    const before = previous.current;
    const scrollToBottom = () => {
      el.scrollTop = el.scrollHeight;
      updateNearBottom(true);
    };
    if (!before) {
      scrollToBottom();
    } else if (last !== before.last) {
      if (lastMessage?.mine || nearBottom.current) {
        scrollToBottom();
      } else {
        setNewBelow(true);
      }
    } else if (first !== before.first) {
      el.scrollTop += el.scrollHeight - before.height;
    }
    previous.current = { first, last, height: el.scrollHeight };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // 開いた後に届いた相手の発言だけを読み上げる（履歴全体は読み上げさせない）
  const newest = messages.at(-1);
  const announcement =
    newest && newest.id !== initialLastId && !newest.mine && !newest.retracted
      ? `${newest.senderName}さんから新着メッセージ（${formatTimeJst(newest.createdAt)}）`
      : '';

  async function loadOlder() {
    setLoadingOlder(true);
    setError(null);
    try {
      await onLoadOlder();
    } catch {
      setError('以前のメッセージを読み込めませんでした。時間をおいてお試しください。');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function retract(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await onRetract(id);
      setConfirmId(null);
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      setError(
        status === 409
          ? '送信から時間が経っているため、取り消せませんでした。'
          : '取り消せませんでした。時間をおいてお試しください。',
      );
      setConfirmId(null);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="relative">
      <div
        ref={scrollerRef}
        onScroll={(event) => {
          updateNearBottom(shouldAutoScroll(event.currentTarget));
        }}
        tabIndex={0}
        role="log"
        aria-label="メッセージの履歴"
        className="card h-[calc(100dvh-30rem)] min-h-[240px] space-y-3 overflow-y-auto bg-field-filled-bg"
      >
        {hasOlder && (
          <div className="text-center">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
            >
              {loadingOlder ? '読み込み中…' : 'さらに前を読む'}
            </button>
          </div>
        )}

        {messages.length === 0 && (
          <EmptyState message="まだメッセージはありません。最初のひとことを送ってみましょう。" />
        )}

        {messages.map((message, index) => {
          const separator =
            index === 0 ||
            dayKeyJst(message.createdAt) !== dayKeyJst(messages[index - 1].createdAt);
          return (
            <div key={message.id}>
              {separator && (
                <p className="my-2 text-center text-caption text-text-muted">
                  <span className="rounded-badge bg-surface px-3 py-1 ring-1 ring-inset ring-border-light">
                    {formatDayLabel(message.createdAt)}
                  </span>
                </p>
              )}
              <div className={`flex ${message.mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] ${message.mine ? 'items-end' : 'items-start'} flex flex-col`}
                >
                  <p className="mb-1 text-caption text-text-muted">
                    {message.senderName || '送信者'}
                    <span className="ml-1">（{SIDE_LABEL[message.senderSide]}）</span>
                  </p>
                  {message.retracted ? (
                    <p className="rounded-card border border-border-light bg-surface px-3 py-2 text-label text-text-muted">
                      メッセージは取り消されました
                    </p>
                  ) : (
                    <p
                      className={`whitespace-pre-wrap break-words rounded-card px-3 py-2 text-label ${
                        message.mine
                          ? 'bg-primary text-white'
                          : 'border border-border-light bg-surface text-text-primary'
                      }`}
                    >
                      {message.body}
                    </p>
                  )}
                  <p className="mt-1 flex items-center gap-2 text-caption text-text-muted">
                    <time dateTime={message.createdAt}>{formatTimeJst(message.createdAt)}</time>
                    {canRetract(message, retractWindowMs, now) &&
                      (confirmId === message.id ? (
                        <span
                          className="flex items-center gap-2"
                          role="group"
                          aria-label="取り消しの確認"
                        >
                          <span>取り消しますか？</span>
                          <button
                            type="button"
                            className="font-bold text-danger underline underline-offset-2"
                            disabled={busyId === message.id}
                            onClick={() => void retract(message.id)}
                          >
                            取り消す
                          </button>
                          <button
                            type="button"
                            className="underline underline-offset-2"
                            disabled={busyId === message.id}
                            onClick={() => setConfirmId(null)}
                          >
                            やめる
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="underline underline-offset-2"
                          onClick={() => setConfirmId(message.id)}
                        >
                          取り消す
                        </button>
                      ))}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {newBelow && (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-badge bg-primary px-4 py-2 text-caption font-bold text-white shadow"
          onClick={() => {
            const el = scrollerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            updateNearBottom(true);
          }}
        >
          新着メッセージ
        </button>
      )}

      {error && (
        <div role="alert" className="banner-error mt-2">
          <span>{error}</span>
        </div>
      )}

      {/* 新着を読み上げるための領域。履歴全体は読み上げさせない */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
