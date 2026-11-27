/** メッセージの入力欄。Enter は改行、Ctrl/Cmd+Enter か送信ボタンで送る。 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { Modal } from '@/components/ui/Modal';
import { api, ApiCallError, handleApiError } from '@/lib/api/client';
import { INPUT_LIMITS } from '@/lib/constants';
import type { RefType } from '@/lib/d1/messages';

const RATE_LIMITED_MESSAGE = '送信が多すぎます。少し待ってから送ってください';
const MAX_REFS = 3;
const TYPE_LABEL: Record<RefType, string> = { task: 'やること', guest: 'ゲスト', seating: '席次' };

interface Candidate {
  type: RefType;
  id: string;
  title: string;
}

/** 添付する項目を、種類を選んで検索し、選ぶダイアログ */
function AttachDialog({
  caseId,
  open,
  chosen,
  returnFocusRef,
  onPick,
  onClose,
}: {
  caseId: string;
  open: boolean;
  chosen: Candidate[];
  returnFocusRef: RefObject<HTMLElement | null>;
  onPick: (item: Candidate) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<RefType>('task');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setFailed(false);
    const timer = setTimeout(() => {
      api
        .get<{ items: Candidate[] }>(
          `/api/cases/${caseId}/chat-refs?type=${type}&q=${encodeURIComponent(query)}`,
        )
        .then((res) => !cancelled && setItems(res.items))
        .catch(() => !cancelled && setFailed(true));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, caseId, type, query]);

  return (
    <Modal
      open={open}
      labelledBy="chat-attach-title"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <h2 id="chat-attach-title" className="section-head">
        添付する項目を選ぶ
      </h2>
      <div role="group" aria-label="種類" className="flex gap-2">
        {(Object.keys(TYPE_LABEL) as RefType[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={type === value}
            className={type === value ? 'btn-primary w-auto px-4' : 'btn-ghost'}
            onClick={() => setType(value)}
          >
            {TYPE_LABEL[value]}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor="chat-attach-q" className="field-label">
          さがす
        </label>
        <input
          id="chat-attach-q"
          className="field"
          value={query}
          maxLength={100}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {failed && (
        <p role="alert" className="banner-error">
          候補を読み込めませんでした。時間をおいてお試しください。
        </p>
      )}
      {items === null && !failed && <p className="text-caption text-text-muted">読み込み中…</p>}
      {items?.length === 0 && (
        <p className="text-caption text-text-muted">該当する項目がありません</p>
      )}
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {items?.map((item) => {
          const picked = chosen.some((c) => c.type === item.type && c.id === item.id);
          return (
            <li key={`${item.type}:${item.id}`}>
              <button
                type="button"
                className="btn-ghost w-full justify-start text-left"
                disabled={picked || chosen.length >= MAX_REFS}
                onClick={() => onPick(item)}
              >
                {item.title}
                {picked && '（選択済み）'}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="text-right">
        <button type="button" className="btn-primary w-auto px-6" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Modal>
  );
}

export function ChatComposer({
  caseId,
  onSend,
}: {
  caseId: string;
  onSend: (body: string, refs: { type: RefType; id: string }[]) => Promise<unknown>;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<Candidate[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim() === '' && refs.length === 0;

  async function submit() {
    if (sendingRef.current || empty) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const sent = text.trim();
      const sentRefs = refs;
      await onSend(
        sent,
        sentRefs.map(({ type, id }) => ({ type, id })),
      );
      // 送信中に打ち足した分は消さない
      setText((current) => (current.trim() === sent ? '' : current));
      setRefs((current) => (current === sentRefs ? [] : current));
    } catch (cause) {
      // 失敗したときは入力を残し、そのまま送り直せるようにする
      if (cause instanceof ApiCallError && cause.status === 429) {
        setError(RATE_LIMITED_MESSAGE);
      } else {
        handleApiError(cause, router, { onSummary: setError });
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      inputRef.current?.focus();
    }
  }

  return (
    <form
      className="mt-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ErrorSummary message={error} />
      <label htmlFor="chat-body" className="field-label">
        メッセージ
      </label>
      <textarea
        id="chat-body"
        ref={inputRef}
        name="body"
        rows={3}
        maxLength={INPUT_LIMITS.textArea}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            void submit();
          }
        }}
        className="field"
        placeholder="ご連絡やご質問をご記入ください"
        aria-describedby="chat-body-hint"
      />
      {refs.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="添付する項目">
          {refs.map((item) => (
            <li
              key={`${item.type}:${item.id}`}
              className="flex items-center gap-1 rounded-badge bg-surface px-3 py-1 text-caption ring-1 ring-inset ring-border-light"
            >
              <span>
                {TYPE_LABEL[item.type]}: {item.title}
              </span>
              <button
                type="button"
                aria-label={`${item.title}の添付を外す`}
                className="px-1 font-bold"
                onClick={() =>
                  setRefs((current) =>
                    current.filter((c) => !(c.type === item.type && c.id === item.id)),
                  )
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <AttachDialog
        caseId={caseId}
        open={attachOpen}
        chosen={refs}
        returnFocusRef={attachButtonRef}
        onPick={(item) => setRefs((current) => [...current, item])}
        onClose={() => setAttachOpen(false)}
      />
      <div className="mt-1 flex items-center justify-between gap-3">
        <p id="chat-body-hint" className="min-w-0 flex-1 text-caption text-text-muted">
          {text.length} / {INPUT_LIMITS.textArea}字
          <span className="hidden sm:inline"> ・ Ctrl+Enter でも送信できます</span>
        </p>
        <button
          ref={attachButtonRef}
          type="button"
          className="btn-ghost shrink-0"
          disabled={refs.length >= MAX_REFS}
          onClick={() => setAttachOpen(true)}
        >
          添付
        </button>
        <button
          type="submit"
          className="btn-primary w-auto shrink-0 whitespace-nowrap px-6"
          disabled={sending || empty}
        >
          {sending ? '送信中…' : '送信'}
        </button>
      </div>
    </form>
  );
}
