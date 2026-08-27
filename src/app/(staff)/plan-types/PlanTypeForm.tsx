/**
 * T03 プラン種別の登録・編集フォーム（admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-18。
 *   割当テンプレートは複数選択とし、行ごとに表示順とプラン固有の逆算日数上書きを設定できる。
 *
 * 保存は page.tsx の Server Action（Supabase クライアント経由・RLS適用）で行い、
 * plan_task_templates は差分更新する。ここは入力と表示だけを持つ。
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ErrorSummary, FieldError } from '@/components/ui/ErrorSummary';
import { INPUT_LIMITS } from '@/lib/constants';
import type { ErrorCode, ErrorDetail } from '@/lib/errors';

/** 6-5-1 のエラーコードと details[] を運ぶ（TemplateForm と同じ約束）。 */
export type SavePlanTypeResult =
  | { ok: true; id: string }
  | { ok: false; code: ErrorCode; message: string; details: ErrorDetail[] };

/** 選択候補として並べる宿題テンプレート（T01 で登録したもの）。 */
export interface TemplateChoice {
  id: string;
  name: string;
  dueOffsetDays: number;
  active: boolean;
}

/** 既存の割当（plan_task_templates）。新規登録時は空。 */
export interface AssignmentInitial {
  taskTemplateId: string;
  displayOrder: number;
  dueOffsetDaysOverride: number | null;
}

export interface PlanTypeFormInitial {
  name: string;
  description: string;
  defaultGuestCountMin: string;
  defaultGuestCountMax: string;
  displayOrder: string;
  active: boolean;
  assignments: AssignmentInitial[];
}

interface Props {
  mode: 'new' | 'edit';
  initial: PlanTypeFormInitial;
  templates: TemplateChoice[];
  save: (values: unknown) => Promise<SavePlanTypeResult>;
}

interface AssignmentState {
  selected: boolean;
  displayOrder: string;
  override: string;
}

/** 空欄は「指定なし」。0 と空欄を取り違えないよう明示的に分けて扱う。 */
function parseOptionalInt(value: string): number | null | 'invalid' {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 'invalid';
  return parsed;
}

export function PlanTypeForm({ mode, initial, templates, save }: Props) {
  const router = useRouter();

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [guestMin, setGuestMin] = useState(initial.defaultGuestCountMin);
  const [guestMax, setGuestMax] = useState(initial.defaultGuestCountMax);
  const [displayOrder, setDisplayOrder] = useState(initial.displayOrder);
  const [active, setActive] = useState(initial.active);

  const [assignments, setAssignments] = useState<Record<string, AssignmentState>>(() => {
    const existing = new Map(initial.assignments.map((a) => [a.taskTemplateId, a]));
    const state: Record<string, AssignmentState> = {};
    templates.forEach((template, index) => {
      const found = existing.get(template.id);
      state[template.id] = {
        selected: found != null,
        displayOrder: String(found?.displayOrder ?? index),
        override: found?.dueOffsetDaysOverride == null ? '' : String(found.dueOffsetDaysOverride),
      };
    });
    return state;
  });

  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const patchAssignment = (id: string, patch: Partial<AssignmentState>) => {
    setAssignments((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSummary(null);
    setFieldErrors({});

    const localErrors: Record<string, string> = {};

    const min = parseOptionalInt(guestMin);
    if (min === 'invalid') localErrors.defaultGuestCountMin = '0以上の整数で入力してください';
    const max = parseOptionalInt(guestMax);
    if (max === 'invalid') localErrors.defaultGuestCountMax = '0以上の整数で入力してください';

    const order = parseOptionalInt(displayOrder);
    if (order === 'invalid') localErrors.displayOrder = '0以上の整数で入力してください';

    const selected = templates.filter((t) => assignments[t.id]?.selected);
    if (selected.length === 0) {
      localErrors.assignments = '宿題テンプレートを1件以上選択してください';
    }

    const rows: { taskTemplateId: string; displayOrder: number; dueOffsetDaysOverride: number | null }[] = [];
    for (const template of selected) {
      const state = assignments[template.id];
      const rowOrder = parseOptionalInt(state.displayOrder);
      const rowOverride = parseOptionalInt(state.override);
      if (rowOrder === 'invalid' || rowOverride === 'invalid') {
        localErrors.assignments = '割当行の表示順・逆算日数は0以上の整数で入力してください';
        continue;
      }
      rows.push({
        taskTemplateId: template.id,
        displayOrder: rowOrder ?? 0,
        dueOffsetDaysOverride: rowOverride,
      });
    }

    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setSaving(true);
    const result = await save({
      name,
      description: description.trim() === '' ? null : description,
      defaultGuestCountMin: min,
      defaultGuestCountMax: max,
      displayOrder: order ?? 0,
      active,
      assignments: rows,
    });
    setSaving(false);

    if (result.ok) {
      router.push('/plan-types');
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
    for (const detail of result.details) {
      // assignments.0.displayOrder のような明細のパスは、まとめて割当セクションへ寄せる
      const key = detail.field.startsWith('assignments') ? 'assignments' : detail.field;
      map[key] ??= detail.reason;
    }
    setFieldErrors(map);
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="card space-y-4">
      <ErrorSummary message={summary} />

      <div>
        <label className="field-label" htmlFor="plan-name">
          プラン種別名（必須）
        </label>
        <input
          id="plan-name"
          className="field"
          value={name}
          maxLength={INPUT_LIMITS.shortText}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={fieldErrors.name ? true : undefined}
        />
        <FieldError message={fieldErrors.name} />
      </div>

      <div>
        <label className="field-label" htmlFor="plan-description">
          説明（任意・{INPUT_LIMITS.templateDescription}字以内）
        </label>
        <textarea
          id="plan-description"
          className="field"
          rows={3}
          value={description}
          maxLength={INPUT_LIMITS.templateDescription}
          onChange={(e) => setDescription(e.target.value)}
        />
        <FieldError message={fieldErrors.description} />
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="min-w-[10rem] flex-1">
          <label className="field-label" htmlFor="plan-guest-min">
            想定人数（下限・任意）
          </label>
          <input
            id="plan-guest-min"
            className="field"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={guestMin}
            onChange={(e) => setGuestMin(e.target.value)}
          />
          <FieldError message={fieldErrors.defaultGuestCountMin} />
        </div>
        <div className="min-w-[10rem] flex-1">
          <label className="field-label" htmlFor="plan-guest-max">
            想定人数（上限・任意）
          </label>
          <input
            id="plan-guest-max"
            className="field"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={guestMax}
            onChange={(e) => setGuestMax(e.target.value)}
          />
          <FieldError message={fieldErrors.defaultGuestCountMax} />
        </div>
        <div className="min-w-[10rem] flex-1">
          <label className="field-label" htmlFor="plan-display-order">
            表示順（任意）
          </label>
          <input
            id="plan-display-order"
            className="field"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={displayOrder}
            onChange={(e) => setDisplayOrder(e.target.value)}
          />
          <FieldError message={fieldErrors.displayOrder} />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="field-label">割当テンプレート（1件以上）</legend>
        <p className="text-caption text-text-muted">
          チェックした宿題が、このプラン種別の案件に一括で割り当てられます。
          逆算日数を空欄にすると、宿題テンプレート側の日数がそのまま使われます。
        </p>

        {templates.length === 0 ? (
          <p className="banner-info">
            先に宿題テンプレートを登録してください。宿題テンプレート画面から追加できます。
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">割当</th>
                  <th scope="col">宿題名</th>
                  <th scope="col">既定の逆算日数</th>
                  <th scope="col">表示順</th>
                  <th scope="col">逆算日数の上書き</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => {
                  const state = assignments[template.id];
                  return (
                    <tr key={template.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${template.name} を割り当てる`}
                          checked={state?.selected ?? false}
                          onChange={(e) => patchAssignment(template.id, { selected: e.target.checked })}
                        />
                      </td>
                      <td>
                        {template.name}
                        {!template.active && <span className="ml-2 badge-neutral">停止中</span>}
                      </td>
                      <td>{template.dueOffsetDays}日前</td>
                      <td>
                        <input
                          className="field w-24"
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          aria-label={`${template.name} の表示順`}
                          disabled={!state?.selected}
                          value={state?.displayOrder ?? ''}
                          onChange={(e) => patchAssignment(template.id, { displayOrder: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="field w-24"
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          placeholder="既定"
                          aria-label={`${template.name} の逆算日数の上書き`}
                          disabled={!state?.selected}
                          value={state?.override ?? ''}
                          onChange={(e) => patchAssignment(template.id, { override: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <FieldError message={fieldErrors.assignments} />
      </fieldset>

      <div>
        <label className="flex items-center gap-2 text-label">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          利用中にする
        </label>
        <p className="mt-1 text-caption text-text-muted">
          オフにすると、これから登録する案件で選べなくなります。すでに登録済みの案件はそのままです。
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
          onClick={() => router.push('/plan-types')}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
