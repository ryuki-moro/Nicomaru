/** スタッフが、チャットのメッセージから期限付きのやることを作るダイアログ。 */
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type RefObject } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { Modal } from '@/components/ui/Modal';
import { api, handleApiError } from '@/lib/api/client';
import { INPUT_LIMITS } from '@/lib/constants';

import type { MessageView } from './chatLogic';

/** 題名の初期値は本文の1行目（長ければ上限で切る） */
export function defaultTaskTitle(body: string | null): string {
  const first = (body ?? '').split('\n')[0].trim();
  return first.slice(0, INPUT_LIMITS.shortText);
}

export function CreateTaskDialog({
  message,
  onClose,
  onCreated,
}: {
  message: MessageView | null;
  onClose: () => void;
  onCreated: (messageId: string, taskId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  return (
    <Modal
      open={message !== null}
      labelledBy="chat-task-title"
      onClose={onClose}
      busy={busy}
      initialFocusRef={titleRef}
    >
      {message && (
        <TaskForm
          // メッセージごとに入力をやり直す
          key={message.id}
          message={message}
          titleRef={titleRef}
          onBusy={setBusy}
          onClose={onClose}
          onCreated={onCreated}
        />
      )}
    </Modal>
  );
}

function TaskForm({
  message,
  titleRef,
  onBusy,
  onClose,
  onCreated,
}: {
  message: MessageView;
  titleRef: RefObject<HTMLInputElement | null>;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onCreated: (messageId: string, taskId: string) => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(() => defaultTaskTitle(message.body));
  const [dueDate, setDueDate] = useState('');
  const [format, setFormat] = useState<'text' | 'none'>('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    if (!title.trim() || !dueDate) {
      setError('題名と期限を入力してください');
      return;
    }
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const created = await api.post<{ id: string }>(`/api/messages/${message.id}/task`, {
        title: title.trim(),
        description: message.body?.trim().slice(0, INPUT_LIMITS.templateDescription) || null,
        submissionFormat: format,
        importance: 'normal',
        isRequired: true,
        allowedFileTypes: [],
        options: {},
        dueDate,
      });
      onCreated(message.id, created.id);
      onBusy(false);
      onClose();
    } catch (cause) {
      handleApiError(cause, router, { onSummary: setError });
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <>
      <h2 id="chat-task-title" className="section-head">
        やることにする
      </h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ErrorSummary message={error} />
        <div>
          <label htmlFor="chat-task-name" className="field-label">
            題名
          </label>
          <input
            id="chat-task-name"
            ref={titleRef}
            className="field"
            value={title}
            maxLength={INPUT_LIMITS.shortText}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="chat-task-due" className="field-label">
            期限
          </label>
          <input
            id="chat-task-due"
            type="date"
            className="field"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="chat-task-format" className="field-label">
            提出
          </label>
          <select
            id="chat-task-format"
            className="field"
            value={format}
            onChange={(event) => setFormat(event.target.value as 'text' | 'none')}
          >
            <option value="text">テキストで回答してもらう</option>
            <option value="none">確認のみ（提出不要）</option>
          </select>
        </div>
        <p className="text-caption text-text-muted">
          メッセージの本文を、やることの説明に入れます。
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            やめる
          </button>
          <button type="submit" className="btn-primary w-auto px-6" disabled={busy}>
            {busy ? '作成中…' : '作成する'}
          </button>
        </div>
      </form>
    </>
  );
}
