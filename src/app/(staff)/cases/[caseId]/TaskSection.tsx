'use client';

/**
 * K02 宿題一覧セクション（機能5-5。planner／admin のみ）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 K02。
 *   - 宿題行ごとに「期限を変更」「対応不要にする（waived）」
 *   - 「宿題を追加」の入力項目は T02（表4-17）と同一。ただし逆算日数ではなく期限を直接指定し、
 *     task_template_id は NULL、display_order は既存の最大値+1（採番はDB側）
 *   - couple には本セクションの操作を表示しない（画面の出し分けは K02 ページ側の責務）
 *
 * 状態の表示名は表6-9 を唯一の対応表とする。waived は「対応不要」と表示する。
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { TaskStatusBadge } from '@/components/ui/StatusBadge';
import { ApiCallError, api } from '@/lib/api/client';
import {
  ALLOWED_FILE_TYPES,
  IMPORTANCE_LABEL,
  IMPORTANCE_LEVELS,
  INPUT_LIMITS,
  SUBMISSION_FORMATS,
  SUBMISSION_FORMAT_LABEL,
  type AllowedFileType,
  type Importance,
  type SubmissionFormat,
  type TaskStatus,
} from '@/lib/constants';

export interface CaseTaskRow {
  id: string;
  title: string;
  dueDate: string;
  status: TaskStatus;
  importance: Importance;
  submissionFormat: SubmissionFormat;
}

interface Props {
  caseId: string;
  tasks: CaseTaskRow[];
  /** プラン種別が未設定だとテンプレートからの一括割当ができない（6-6-2） */
  hasPlanType: boolean;
  /** アーカイブ済み案件は編集させない（K05／2-5） */
  readOnly: boolean;
}

const formatDate = (value: string) => value.replaceAll('-', '/');

const emptyDraft = {
  title: '',
  description: '',
  submissionFormat: 'text' as SubmissionFormat,
  allowedFileTypes: [] as AllowedFileType[],
  choices: '',
  importance: 'normal' as Importance,
  isRequired: true,
  dueDate: '',
};

export function TaskSection({ caseId, tasks, hasPlanType, readOnly }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDate, setEditingDate] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);

  function fail(error: unknown, fallback: string) {
    if (error instanceof ApiCallError) {
      setSummary(error.message);
      setFieldErrors(error.fieldErrors);
    } else {
      setSummary(fallback);
    }
  }

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setSummary(null);
    setNotice(null);
    setFieldErrors({});
    try {
      setNotice(await action());
      router.refresh();
    } catch (error) {
      fail(error, '処理できませんでした。時間をおいてもう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  const assignTasks = () =>
    run(async () => {
      const result = await api.post<{ added: number }>(`/api/cases/${caseId}/assign-tasks`);
      return result.added === 0
        ? '追加する宿題はありませんでした。'
        : `宿題を${result.added}件追加しました。`;
    });

  const saveDueDate = (taskId: string) =>
    run(async () => {
      await api.patch(`/api/cases/${caseId}/tasks/${taskId}`, { dueDate: editingDate });
      setEditingId(null);
      return '期限を変更しました。';
    });

  const setWaived = (taskId: string, waived: boolean) =>
    run(async () => {
      await api.patch(`/api/cases/${caseId}/tasks/${taskId}`, { waived });
      return waived ? '対応不要に変更しました。' : '対応不要を解除しました。';
    });

  const addTask = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return run(async () => {
      const choices = draft.choices
        .split('\n')
        .map((choice) => choice.trim())
        .filter((choice) => choice.length > 0);

      await api.post(`/api/cases/${caseId}/tasks`, {
        title: draft.title,
        description: draft.description === '' ? null : draft.description,
        submissionFormat: draft.submissionFormat,
        allowedFileTypes: draft.allowedFileTypes,
        options: draft.submissionFormat === 'select' ? { choices } : {},
        importance: draft.importance,
        isRequired: draft.isRequired,
        dueDate: draft.dueDate,
      });
      setDraft(emptyDraft);
      setAdding(false);
      return '宿題を追加しました。';
    });
  };

  const toggleFileType = (type: AllowedFileType) =>
    setDraft((prev) => ({
      ...prev,
      allowedFileTypes: prev.allowedFileTypes.includes(type)
        ? prev.allowedFileTypes.filter((t) => t !== type)
        : [...prev.allowedFileTypes, type],
    }));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-head">宿題（{tasks.length}件）</h2>
        {!readOnly && (
          <button
            type="button"
            className="btn-secondary w-auto px-4 py-2"
            onClick={() => setAdding((prev) => !prev)}
            disabled={busy}
          >
            {adding ? '追加をやめる' : '宿題を追加'}
          </button>
        )}
      </div>

      <ErrorSummary message={summary} />
      {notice && (
        <div role="status" className="banner-info">
          <span>{notice}</span>
        </div>
      )}

      {tasks.length === 0 && (
        <div className="card space-y-2">
          <p className="text-label text-text-secondary">
            まだ宿題が割り当てられていません。
          </p>
          {!readOnly && hasPlanType && (
            <button type="button" className="btn-primary" onClick={assignTasks} disabled={busy}>
              プラン種別の宿題を割り当てる
            </button>
          )}
          {!hasPlanType && (
            <p className="text-caption text-text-muted">
              プラン種別が設定されていないため一括割当ができません。案件変更から設定してください。
            </p>
          )}
        </div>
      )}

      {tasks.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">宿題名</th>
                <th scope="col">提出形式</th>
                <th scope="col">重要度</th>
                <th scope="col">期限</th>
                <th scope="col">状態</th>
                {!readOnly && <th scope="col">操作</th>}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>{task.title}</td>
                  <td>{SUBMISSION_FORMAT_LABEL[task.submissionFormat]}</td>
                  <td>{IMPORTANCE_LABEL[task.importance]}</td>
                  <td>
                    {editingId === task.id ? (
                      <input
                        type="date"
                        className="field"
                        aria-label={`${task.title}の新しい期限`}
                        value={editingDate}
                        onChange={(e) => setEditingDate(e.target.value)}
                      />
                    ) : (
                      formatDate(task.dueDate)
                    )}
                  </td>
                  <td>
                    <TaskStatusBadge status={task.status} />
                  </td>
                  {!readOnly && (
                    <td>
                      <div className="flex flex-wrap gap-2">
                        {editingId === task.id ? (
                          <>
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={busy || editingDate === ''}
                              onClick={() => saveDueDate(task.id)}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => setEditingId(null)}
                            >
                              やめる
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => {
                              setEditingId(task.id);
                              setEditingDate(task.dueDate);
                            }}
                          >
                            期限を変更
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy}
                          onClick={() => setWaived(task.id, task.status !== 'waived')}
                        >
                          {task.status === 'waived' ? '対応不要を解除' : '対応不要にする'}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && !readOnly && (
        <form onSubmit={addTask} className="card space-y-3" noValidate>
          <h3 className="text-label font-medium">宿題を追加</h3>

          <div>
            <label htmlFor="task-title" className="field-label">
              宿題名（必須）
            </label>
            <input
              id="task-title"
              className="field"
              maxLength={120}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              required
            />
            <FieldError message={fieldErrors.title} />
          </div>

          <div>
            <label htmlFor="task-description" className="field-label">
              説明（任意）
            </label>
            <textarea
              id="task-description"
              className="field"
              rows={3}
              maxLength={INPUT_LIMITS.templateDescription}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <FieldError message={fieldErrors.description} />
          </div>

          <div>
            <label htmlFor="task-format" className="field-label">
              提出フォーマット（必須）
            </label>
            <select
              id="task-format"
              className="field"
              value={draft.submissionFormat}
              onChange={(e) =>
                setDraft({ ...draft, submissionFormat: e.target.value as SubmissionFormat })
              }
            >
              {SUBMISSION_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {SUBMISSION_FORMAT_LABEL[format]}
                </option>
              ))}
            </select>
            <FieldError message={fieldErrors.submissionFormat} />
          </div>

          {draft.submissionFormat === 'file' && (
            <fieldset>
              <legend className="field-label">受入ファイル形式（1つ以上）</legend>
              <div className="flex gap-4">
                {ALLOWED_FILE_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-1 text-label">
                    <input
                      type="checkbox"
                      checked={draft.allowedFileTypes.includes(type)}
                      onChange={() => toggleFileType(type)}
                    />
                    {type.toUpperCase()}
                  </label>
                ))}
              </div>
              <FieldError message={fieldErrors.allowedFileTypes} />
            </fieldset>
          )}

          {draft.submissionFormat === 'select' && (
            <div>
              <label htmlFor="task-choices" className="field-label">
                選択肢（1行に1つ）
              </label>
              <textarea
                id="task-choices"
                className="field"
                rows={4}
                value={draft.choices}
                onChange={(e) => setDraft({ ...draft, choices: e.target.value })}
              />
              <FieldError message={fieldErrors.options} />
            </div>
          )}

          <div>
            <label htmlFor="task-importance" className="field-label">
              重要度
            </label>
            <select
              id="task-importance"
              className="field"
              value={draft.importance}
              onChange={(e) => setDraft({ ...draft, importance: e.target.value as Importance })}
            >
              {IMPORTANCE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {IMPORTANCE_LABEL[level]}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-label">
            <input
              type="checkbox"
              checked={draft.isRequired}
              onChange={(e) => setDraft({ ...draft, isRequired: e.target.checked })}
            />
            必須提出物にする
          </label>

          <div>
            <label htmlFor="task-due" className="field-label">
              期限（必須）
            </label>
            <input
              id="task-due"
              type="date"
              className="field"
              value={draft.dueDate}
              onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
              required
            />
            <FieldError message={fieldErrors.dueDate} />
          </div>

          <button type="submit" className="btn-primary" disabled={busy}>
            追加する
          </button>
        </form>
      )}
    </section>
  );
}
