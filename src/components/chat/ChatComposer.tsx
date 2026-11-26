/** メッセージの入力欄。Enter は改行、Ctrl/Cmd+Enter か送信ボタンで送る。 */
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { ApiCallError, handleApiError } from '@/lib/api/client';
import { INPUT_LIMITS } from '@/lib/constants';

const RATE_LIMITED_MESSAGE = '送信が多すぎます。少し待ってから送ってください';

export function ChatComposer({ onSend }: { onSend: (body: string) => Promise<unknown> }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim() === '';

  async function submit() {
    if (sendingRef.current || empty) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim());
      setText('');
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
      <div className="mt-1 flex items-center justify-between gap-3">
        <p id="chat-body-hint" className="text-caption text-text-muted">
          {text.length} / {INPUT_LIMITS.textArea}字 ・ Ctrl+Enter でも送信できます
        </p>
        <button type="submit" className="btn-primary w-auto px-6" disabled={sending || empty}>
          {sending ? '送信中…' : '送信'}
        </button>
      </div>
    </form>
  );
}
