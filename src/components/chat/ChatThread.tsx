/**
 * チャットの発言一覧。古いものが上、新しいものが下。
 * 本文は文字列のまま描画する（HTML として解釈せず、リンクにもしない）。
 */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import Link from 'next/link';

import { EmptyState } from '@/components/ui/EmptyState';

import {
  canRetract,
  dayKeyJst,
  formatDayLabel,
  formatTimeJst,
  shouldAutoScroll,
} from './chatLogic';
import type { MessageView } from './chatLogic';
import { RefCard } from './RefCard';

const SIDE_LABEL = { staff: '担当者', couple: '新郎新婦' } as const;

interface Props {
  messages: MessageView[];
  hasOlder: boolean;
  retractWindowMs: number;
  onLoadOlder: () => Promise<void>;
  onRetract: (id: string) => Promise<void>;
  /** 下端まで読んでいるかが変わったとき（既読の判定に使う） */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** 渡されたときだけ（スタッフ）、メッセージの「…」メニューに「やることにする」を出す */
  onCreateTask?: (message: MessageView) => void;
}

/** システムメッセージ（提出・承認・期限など）。中央寄せの小さい行。取り消しはできない */
function SystemRow({ message }: { message: MessageView }) {
  const href = message.refs.find((r) => r.href)?.href;
  const text = (
    <>
      <span className="sr-only">お知らせ: </span>
      {message.body}
      <time className="ml-2" dateTime={message.createdAt}>
        {formatTimeJst(message.createdAt)}
      </time>
    </>
  );
  const cls =
    'inline-block rounded-badge bg-surface px-3 py-1 text-caption text-text-muted ring-1 ring-inset ring-border-light';
  return (
    <p className="text-center" data-system-message>
      {href ? (
        <Link href={href} className={`${cls} underline-offset-2 hover:underline`}>
          {text}
        </Link>
      ) : (
        <span className={cls}>{text}</span>
      )}
    </p>
  );
}

export function ChatThread({
  messages,
  hasOlder,
  retractWindowMs,
  onLoadOlder,
  onRetract,
  onAtBottomChange,
  onCreateTask,
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
      ? newest.kind === 'system'
        ? `お知らせ: ${newest.body}`
        : `${newest.senderName}さんから新着メッセージ（${formatTimeJst(newest.createdAt)}）`
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
              {message.kind === 'system' ? (
                <SystemRow message={message} />
              ) : (
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
                      <>
                        {message.body && (
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
                        {message.refs.length > 0 && (
                          <ul className="mt-1 w-full space-y-1" aria-label="添付された項目">
                            {message.refs.map((item) => (
                              <li key={`${item.type}:${item.id}`}>
                                <RefCard item={item} />
                              </li>
                            ))}
                          </ul>
                        )}
                        {message.linkedTaskIds.length > 0 && (
                          <p className="mt-1 text-caption text-text-muted">やること化済み</p>
                        )}
                      </>
                    )}
                    <p className="mt-1 flex items-center gap-2 text-caption text-text-muted">
                      <time dateTime={message.createdAt}>{formatTimeJst(message.createdAt)}</time>
                      {onCreateTask && !message.retracted && (
                        <details className="relative">
                          <summary
                            className="cursor-pointer list-none px-1 font-bold"
                            aria-label="メッセージのメニュー"
                          >
                            …
                          </summary>
                          <div className="absolute left-0 z-10 mt-1 rounded-card border border-border-light bg-surface p-1 shadow">
                            <button
                              type="button"
                              className="whitespace-nowrap px-3 py-1 text-label text-text-primary"
                              onClick={(event) => {
                                event.currentTarget.closest('details')?.removeAttribute('open');
                                onCreateTask(message);
                              }}
                            >
                              やることにする
                            </button>
                          </div>
                        </details>
                      )}
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
              )}
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
