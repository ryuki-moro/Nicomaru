/**
 * T03 プラン種別管理（admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-18。
 *   プラン種別ごとに宿題テンプレートのセット（plan_task_templates）を管理する。
 *   ここで組んだセットが K03 の案件登録時に一括割当される（6-6-2）。
 *
 * 一覧と編集フォームを1画面に置き、編集対象は ?edit=<id>（新規は ?edit=new）で選ぶ。
 * 読み書きとも Supabase クライアント経由（RLS適用。plan_types_write は admin のみ）。
 *
 * 4-3 一覧画面共通：既定の表示件数は50件、以降はページング。
 * 打ち切るだけでは51件目以降のプラン種別を編集・停止できなくなるため、
 * K01／M02 と同じく1件多く取って前後リンクを出す（?page=）。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser, landingPathFor } from '@/lib/auth/session';
import { LIST_PAGE_SIZE } from '@/lib/constants';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { planTypeSaveSchema, toErrorDetails } from '@/lib/validation';

import {
  PlanTypeForm,
  type PlanTypeFormInitial,
  type SavePlanTypeResult,
  type TemplateChoice,
} from './PlanTypeForm';

/** 一覧と「編集対象を id で引き直す」問い合わせで同じ列を使う。 */
const PLAN_TYPE_COLUMNS =
  'id, name, description, default_guest_count_min, default_guest_count_max, display_order, active' as const;

interface PlanTypeRow {
  id: string;
  name: string;
  description: string | null;
  default_guest_count_min: number | null;
  default_guest_count_max: number | null;
  display_order: number;
  active: boolean;
}

interface TemplateRow {
  id: string;
  name: string;
  due_offset_days: number;
  active: boolean;
}

interface AssignmentRow {
  plan_type_id: string;
  task_template_id: string;
  display_order: number;
  due_offset_days_override: number | null;
}

function mapWriteError(error: { code?: string; message?: string }): SavePlanTypeResult {
  if (error.code === '23505') {
    // 表4-18 の「式場内重複（UNIQUE(venue_id, name)）」に対応する分岐
    return {
      ok: false,
      code: 'CONFLICT',
      message: '同じプラン種別名が既に登録されています',
      details: [{ field: 'name', reason: '式場内で重複しない名前を入力してください' }],
    };
  }
  const mapped = fromPostgresError(error);
  return { ok: false, code: mapped.code, message: mapped.message, details: mapped.details ?? [] };
}

/**
 * プラン種別と割当テンプレートの保存。
 *
 * plan_task_templates は「全消し→全入れ」ではなく差分更新にする。
 * 全消しすると display_order／override を書き換えていない行まで更新扱いになり、
 * 監査ログ・updated_at の変化から実際の変更が読み取れなくなるため（9-1）。
 */
async function savePlanType(planTypeId: string, values: unknown): Promise<SavePlanTypeResult> {
  'use server';

  const user = await getAppUser();
  if (!user || user.role !== 'admin' || !user.venueId) {
    return { ok: false, code: 'FORBIDDEN', message: 'この操作を行う権限がありません', details: [] };
  }

  const parsed = planTypeSaveSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: '入力内容に誤りがあります',
      details: toErrorDetails(parsed.error),
    };
  }
  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // plan_task_templates の RLS はプラン種別側の式場しか見ない（plan_type_venue）。
  // 他式場のテンプレートIDを直接送られても通らないよう、参照可否をここで確かめる。
  const templateIds = input.assignments.map((a) => a.taskTemplateId);
  const { data: visible, error: visibleError } = await supabase
    .from('task_templates')
    .select('id')
    .in('id', templateIds);
  if (visibleError) return mapWriteError(visibleError);
  if ((visible ?? []).length !== templateIds.length) {
    return {
      ok: false,
      code: 'UNPROCESSABLE',
      message: '選択できない宿題テンプレートが含まれています',
      details: [{ field: 'assignments', reason: '一覧から選び直してください' }],
    };
  }

  const row = {
    name: input.name,
    description: input.description ?? null,
    default_guest_count_min: input.defaultGuestCountMin ?? 0,
    default_guest_count_max: input.defaultGuestCountMax ?? null,
    display_order: input.displayOrder,
    active: input.active,
  };

  const { data: saved, error: saveError } = planTypeId === 'new'
    ? await supabase
      .from('plan_types')
      .insert({ ...row, venue_id: user.venueId })
      .select('id')
      .single()
    : await supabase
      .from('plan_types')
      .update(row)
      .eq('id', planTypeId)
      .select('id')
      .single();

  if (saveError) return mapWriteError(saveError);
  const savedId = (saved as { id: string }).id;

  const { data: existing, error: existingError } = await supabase
    .from('plan_task_templates')
    .select('task_template_id')
    .eq('plan_type_id', savedId);
  if (existingError) return mapWriteError(existingError);

  const keep = new Set(templateIds);
  const removed = (existing as { task_template_id: string }[] | null ?? [])
    .map((r) => r.task_template_id)
    .filter((id) => !keep.has(id));

  if (removed.length > 0) {
    const { error } = await supabase
      .from('plan_task_templates')
      .delete()
      .eq('plan_type_id', savedId)
      .in('task_template_id', removed);
    if (error) return mapWriteError(error);
  }

  // 追加と更新（display_order／逆算日数の上書き）は onConflict で1回にまとめる
  const { error: upsertError } = await supabase.from('plan_task_templates').upsert(
    input.assignments.map((a) => ({
      plan_type_id: savedId,
      task_template_id: a.taskTemplateId,
      display_order: a.displayOrder,
      due_offset_days_override: a.dueOffsetDaysOverride ?? null,
    })),
    { onConflict: 'plan_type_id,task_template_id' },
  );
  if (upsertError) return mapWriteError(upsertError);

  revalidatePath('/plan-types');
  revalidatePath('/templates');
  return { ok: true, id: savedId };
}

/** ?page= を1始まりのページ番号にする。壊れた値は1ページ目へ寄せる（K01／M02 と同じ扱い）。 */
function resolvePage(raw: string | undefined): number {
  const parsed = Number(raw ?? '1');
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** 編集対象（?edit=）とページ（?page=）は互いに独立して保つ。 */
function hrefFor(params: { edit?: string; page?: number }): string {
  const query = new URLSearchParams();
  if (params.edit) query.set('edit', params.edit);
  if (params.page && params.page > 1) query.set('page', String(params.page));
  const search = query.toString();
  return search ? `/plan-types?${search}` : '/plan-types';
}

export default async function PlanTypesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; page?: string }>;
}) {
  const { edit, page: pageParam } = await searchParams;
  const page = resolvePage(pageParam);

  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect(landingPathFor(user.role));

  const supabase = await createSupabaseServerClient();

  // 編集対象は一覧の結果から探さず id で直接引く。
  // ページングを入れた以上、2ページ目を開いた状態で1ページ目の行を編集する場合に
  // 一覧から探すと対象が見つからずフォームが黙って消えるため。
  const editingQuery = edit && edit !== 'new'
    ? supabase.from('plan_types').select(PLAN_TYPE_COLUMNS).eq('id', edit).maybeSingle()
    : null;

  // 1件多く取り、次ページの有無を件数の追加問い合わせなしで判定する（K01／M02 と同じ形）。
  const from = (page - 1) * LIST_PAGE_SIZE;
  const [planTypesResult, templatesResult, assignmentsResult, editingResult] = await Promise.all([
    supabase
      .from('plan_types')
      // count は新規登録時の表示順の既定値（末尾）に使う。ページ内の件数では代用できない
      .select(PLAN_TYPE_COLUMNS, { count: 'exact' })
      .order('active', { ascending: false })
      .order('display_order')
      .order('name')
      .order('id')
      .range(from, from + LIST_PAGE_SIZE),
    supabase
      .from('task_templates')
      .select('id, name, due_offset_days, active')
      .order('due_offset_days', { ascending: false })
      .order('name')
      .order('id'),
    supabase
      .from('plan_task_templates')
      .select('plan_type_id, task_template_id, display_order, due_offset_days_override'),
    editingQuery,
  ]);

  const fetched: PlanTypeRow[] = planTypesResult.data ?? [];
  const hasNext = fetched.length > LIST_PAGE_SIZE;
  const planTypes = fetched.slice(0, LIST_PAGE_SIZE);
  const templateRows: TemplateRow[] = templatesResult.data ?? [];
  const assignments: AssignmentRow[] = assignmentsResult.data ?? [];

  const assignedCount = new Map<string, number>();
  for (const a of assignments) {
    assignedCount.set(a.plan_type_id, (assignedCount.get(a.plan_type_id) ?? 0) + 1);
  }

  // 権限外・不存在の id は RLS により 0 行になるので、フォームを出さないことで自然に弾かれる
  const editingRow = (editingResult?.data ?? null) as PlanTypeRow | null;
  const editing = edit === 'new' ? 'new' : editingRow?.id ?? null;

  const templates: TemplateChoice[] = templateRows.map((t) => ({
    id: t.id,
    name: t.name,
    dueOffsetDays: t.due_offset_days,
    active: t.active,
  }));

  const initial: PlanTypeFormInitial = {
    name: editingRow?.name ?? '',
    description: editingRow?.description ?? '',
    defaultGuestCountMin: editingRow?.default_guest_count_min == null
      ? '' : String(editingRow.default_guest_count_min),
    defaultGuestCountMax: editingRow?.default_guest_count_max == null
      ? '' : String(editingRow.default_guest_count_max),
    // 新規は既存の総数＝末尾を既定値にする。ページ内の件数だと2ページ目以降で先頭に割り込む
    displayOrder: editingRow
      ? String(editingRow.display_order)
      : String(planTypesResult.count ?? planTypes.length),
    active: editingRow?.active ?? true,
    assignments: editingRow
      ? assignments
        .filter((a) => a.plan_type_id === editingRow.id)
        .map((a) => ({
          taskTemplateId: a.task_template_id,
          displayOrder: a.display_order,
          dueOffsetDaysOverride: a.due_offset_days_override,
        }))
      : [],
  };

  const guestRange = (row: PlanTypeRow) => {
    if (row.default_guest_count_min == null && row.default_guest_count_max == null) return '未設定';
    return `${row.default_guest_count_min ?? 0}〜${row.default_guest_count_max ?? ''}名`;
  };

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/dashboard" className="text-link hover:underline">
              ダッシュボード
            </Link>
          </li>
          <li className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <span aria-current="page">プラン種別管理</span>
          </li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="section-head">プラン種別管理</h1>
        <div className="flex items-center gap-3">
          <Link href="/templates" className="btn-ghost">
            宿題テンプレート
          </Link>
          <Link href={hrefFor({ edit: 'new', page })} className="btn-primary w-auto">
            新規登録
          </Link>
        </div>
      </div>

      {planTypesResult.error && (
        <p role="alert" className="banner-error">
          プラン種別を読み込めませんでした。画面を更新してからもう一度お試しください。
        </p>
      )}

      {planTypes.length === 0 && !planTypesResult.error ? (
        <EmptyState
          message={
            page > 1
              ? 'これ以上のプラン種別はありません。'
              : 'まだプラン種別がありません。「新規登録」から追加してください。'
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">プラン種別名</th>
                <th scope="col">想定人数</th>
                <th scope="col">割当テンプレート</th>
                <th scope="col">表示順</th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {planTypes.map((planType) => (
                <tr key={planType.id}>
                  <td>
                    <Link
                      href={hrefFor({ edit: planType.id, page })}
                      className="text-link hover:underline"
                    >
                      {planType.name}
                    </Link>
                  </td>
                  <td>{guestRange(planType)}</td>
                  <td>{assignedCount.get(planType.id) ?? 0}件</td>
                  <td>{planType.display_order}</td>
                  <td>
                    <span className={planType.active ? 'badge-success' : 'badge-neutral'}>
                      {planType.active ? '利用中' : '停止中'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(page > 1 || hasNext) && (
        <nav aria-label="ページ送り" className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={hrefFor({ edit, page: page - 1 })} className="btn-ghost">
              前の{LIST_PAGE_SIZE}件
            </Link>
          ) : (
            <span />
          )}
          {hasNext && (
            <Link href={hrefFor({ edit, page: page + 1 })} className="btn-ghost">
              次の{LIST_PAGE_SIZE}件
            </Link>
          )}
        </nav>
      )}

      {editing && (
        <section className="space-y-3">
          <h2 className="section-head">
            {editing === 'new' ? 'プラン種別の新規登録' : `プラン種別の編集：${editingRow?.name ?? ''}`}
          </h2>
          <PlanTypeForm
            /* 編集対象が変わったらフォームの内部状態を作り直す */
            key={editing}
            mode={editing === 'new' ? 'new' : 'edit'}
            initial={initial}
            templates={templates}
            save={savePlanType.bind(null, editing)}
          />
        </section>
      )}
    </div>
  );
}
