/**
 * T02 宿題テンプレート登録・編集フォーム（admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-17。
 * 保存は page.tsx の Server Action（Supabase クライアント経由・RLS適用）へ委ねる。
 * ここは入力と表示だけを持ち、値域・表示名は @/lib/constants を単一ソースとする（12-2）。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
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
} from '@/lib/constants';
import type { ErrorCode, ErrorDetail } from '@/lib/errors';

/**
 * Server Action の戻り値。6-5-1 のエラーコードと details[] をそのまま運び、
 * 画面側が「項目直下」「フォーム上部」「P04 へ遷移」を出し分けられる形にする。
 */
export type SaveTemplateResult =
  | { ok: true; id: string }
  | { ok: false; code: ErrorCode; message: string; details: ErrorDetail[] };

export interface TemplateFormInitial {
  name: string;
  description: string;
  submissionFormat: SubmissionFormat;
  allowedFileTypes: AllowedFileType[];
  choices: string[];
  dueOffsetDays: string;
  importance: Importance;
  isRequired: boolean;
  active: boolean;
}

interface Props {
  mode: 'new' | 'edit';
  initial: TemplateFormInitial;
  save: (values: unknown) => Promise<SaveTemplateResult>;
}

export function TemplateForm({ mode, initial, save }: Props) {
  const router = useRouter();

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [submissionFormat, setSubmissionFormat] = useState<SubmissionFormat>(initial.submissionFormat);
  const [allowedFileTypes, setAllowedFileTypes] = useState<AllowedFileType[]>(initial.allowedFileTypes);
  const [choicesText, setChoicesText] = useState(initial.choices.join('\n'));
  const [dueOffsetDays, setDueOffsetDays] = useState(initial.dueOffsetDays);
  const [importance, setImportance] = useState<Importance>(initial.importance);
  const [isRequired, setIsRequired] = useState(initial.isRequired);
  const [active, setActive] = useState(initial.active);

  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const toggleFileType = (type: AllowedFileType) => {
    setAllowedFileTypes((current) =>
      current.includes(type) ? current.filter((t) => t !== type) : [...current, type]);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSummary(null);
    setFieldErrors({});

    // 数値は空文字だと 0 に化けるため、サーバーへ送る前にここで弾く（4-3 エラー表示規約）
    const offset = Number(dueOffsetDays);
    if (dueOffsetDays.trim() === '' || !Number.isInteger(offset) || offset < 0) {
      setFieldErrors({ dueOffsetDays: '0以上の整数で入力してください' });
      return;
    }

    setSaving(true);
    const result = await save({
      name,
      description: description.trim() === '' ? null : description,
      submissionFormat,
      // 提出フォーマットに関係ない値を送ると DB のスナップショット（6-6-2）が汚れる
      allowedFileTypes: submissionFormat === 'file' ? allowedFileTypes : [],
      defaultOptions: submissionFormat === 'select'
        ? { choices: choicesText.split('\n').map((line) => line.trim()).filter(Boolean) }
        : {},
      dueOffsetDays: offset,
      importance,
      isRequired,
      active,
    });
    setSaving(false);

    if (result.ok) {
      router.push('/templates');
      router.refresh();
      return;
    }

    // 4-3 エラー表示規約: 権限エラー・不存在は P04 へ遷移する
    if (result.code === 'FORBIDDEN' || result.code === 'NOT_FOUND') {
      router.push(`/error?code=${result.code === 'FORBIDDEN' ? '403' : '404'}`);
      return;
    }

    setSummary(result.message);
    const map: Record<string, string> = {};
    for (const detail of result.details) map[detail.field] ??= detail.reason;
    setFieldErrors(map);
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="card space-y-4">
      <ErrorSummary message={summary} />

      <div>
        <label className="field-label" htmlFor="template-name">
          宿題名（必須）
        </label>
        <input
          id="template-name"
          className="field"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={fieldErrors.name ? true : undefined}
        />
        <FieldError message={fieldErrors.name} />
      </div>

      <div>
        <label className="field-label" htmlFor="template-description">
          説明（任意・{INPUT_LIMITS.templateDescription}字以内）
        </label>
        <textarea
          id="template-description"
          className="field"
          rows={4}
          value={description}
          maxLength={INPUT_LIMITS.templateDescription}
          onChange={(e) => setDescription(e.target.value)}
        />
        <FieldError message={fieldErrors.description} />
      </div>

      <div>
        <label className="field-label" htmlFor="template-format">
          提出フォーマット（必須）
        </label>
        <select
          id="template-format"
          className="field"
          value={submissionFormat}
          onChange={(e) => setSubmissionFormat(e.target.value as SubmissionFormat)}
        >
          {SUBMISSION_FORMATS.map((format) => (
            <option key={format} value={format}>
              {SUBMISSION_FORMAT_LABEL[format]}
            </option>
          ))}
        </select>
        <FieldError message={fieldErrors.submissionFormat} />
      </div>

      {submissionFormat === 'file' && (
        <fieldset>
          <legend className="field-label">受入ファイル形式（1つ以上）</legend>
          <div className="flex flex-wrap gap-4">
            {ALLOWED_FILE_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 text-label">
                <input
                  type="checkbox"
                  checked={allowedFileTypes.includes(type)}
                  onChange={() => toggleFileType(type)}
                />
                {type.toUpperCase()}
              </label>
            ))}
          </div>
          <FieldError message={fieldErrors.allowedFileTypes} />
        </fieldset>
      )}

      {submissionFormat === 'select' && (
        <div>
          <label className="field-label" htmlFor="template-choices">
            選択肢（1行に1つ）
          </label>
          <textarea
            id="template-choices"
            className="field"
            rows={4}
            value={choicesText}
            placeholder={'和装\n洋装\n未定'}
            onChange={(e) => setChoicesText(e.target.value)}
          />
          <FieldError message={fieldErrors.defaultOptions} />
        </div>
      )}

      <div>
        <label className="field-label" htmlFor="template-offset">
          逆算日数（必須・挙式日から何日前を期限とするか）
        </label>
        <input
          id="template-offset"
          className="field"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={dueOffsetDays}
          onChange={(e) => setDueOffsetDays(e.target.value)}
          aria-invalid={fieldErrors.dueOffsetDays ? true : undefined}
        />
        <FieldError message={fieldErrors.dueOffsetDays} />
      </div>

      <div>
        <label className="field-label" htmlFor="template-importance">
          重要度（必須）
        </label>
        <select
          id="template-importance"
          className="field"
          value={importance}
          onChange={(e) => setImportance(e.target.value as Importance)}
        >
          {IMPORTANCE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {IMPORTANCE_LABEL[level]}
            </option>
          ))}
        </select>
        <p className="mt-1 text-caption text-text-muted">
          「重要」以上はプランナー側のリスク判定に使われます。
        </p>
        <FieldError message={fieldErrors.importance} />
      </div>

      <label className="flex items-center gap-2 text-label">
        <input
          type="checkbox"
          checked={isRequired}
          onChange={(e) => setIsRequired(e.target.checked)}
        />
        必須提出物にする
      </label>

      <div>
        <label className="flex items-center gap-2 text-label">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          利用中にする
        </label>
        <p className="mt-1 text-caption text-text-muted">
          オフにすると、これから登録する案件には割り当てられなくなります。
          すでに割り当て済みの案件の宿題はそのまま残ります。
        </p>
      </div>

      <div className="flex gap-3 pt-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? '保存しています…' : mode === 'new' ? '登録する' : '変更を保存'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={saving}
          onClick={() => router.push('/templates')}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
