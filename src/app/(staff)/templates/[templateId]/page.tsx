/**
 * T02 宿題テンプレート登録・編集（admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-17。
 * URL の templateId が 'new' のときは新規登録、UUID のときは編集として扱う。
 *
 * 6-5 の原則により、テンプレート管理は Route Handler を作らず
 * Supabase クライアント（RLS適用）へ直接書く。RLS の task_templates_write が
 * 「admin かつ自式場」を保証するため、API 層で式場境界を再実装しない。
 * 書き込みは Server Action に置き、秘匿値やエラー写像をブラウザへ持ち出さない。
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { getAppUser, landingPathFor } from '@/lib/auth/session';
import {
  type AllowedFileType,
  type Importance,
  type SubmissionFormat,
} from '@/lib/constants';
import { fromPostgresError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { taskTemplateSchema, toErrorDetails } from '@/lib/validation';

import { TemplateForm, type SaveTemplateResult, type TemplateFormInitial } from './TemplateForm';

interface TemplateRecord {
  id: string;
  name: string;
  description: string | null;
  submission_format: SubmissionFormat;
  allowed_file_types: AllowedFileType[] | null;
  default_options: { choices?: string[] } | null;
  due_offset_days: number;
  importance: Importance;
  is_required: boolean;
  active: boolean;
}

/** 一意制約違反（式場内の宿題名重複）は項目直下へ出したいので個別に文言を当てる（表4-17）。 */
function mapWriteError(error: { code?: string; message?: string }): SaveTemplateResult {
  if (error.code === '23505') {
    // 表4-17 の「式場内重複（UNIQUE 違反は 409）」に対応する分岐
    return {
      ok: false,
      code: 'CONFLICT',
      message: '同じ宿題名のテンプレートが既に登録されています',
      details: [{ field: 'name', reason: '式場内で重複しない名前を入力してください' }],
    };
  }
  const mapped = fromPostgresError(error);
  return { ok: false, code: mapped.code, message: mapped.message, details: mapped.details ?? [] };
}

/**
 * 保存（新規・編集共通）。
 * templateId は bind で固定するため、クライアントから任意の ID を差し替えられない。
 */
async function saveTemplate(templateId: string, values: unknown): Promise<SaveTemplateResult> {
  'use server';

  const user = await getAppUser();
  if (!user || user.role !== 'admin' || !user.venueId) {
    return { ok: false, code: 'FORBIDDEN', message: 'この操作を行う権限がありません', details: [] };
  }

  const parsed = taskTemplateSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: '入力内容に誤りがあります',
      details: toErrorDetails(parsed.error),
    };
  }
  const input = parsed.data;

  const row = {
    name: input.name,
    description: input.description ?? null,
    submission_format: input.submissionFormat,
    allowed_file_types: input.allowedFileTypes,
    default_options: input.defaultOptions,
    due_offset_days: input.dueOffsetDays,
    importance: input.importance,
    is_required: input.isRequired,
    active: input.active,
  };

  const supabase = await createSupabaseServerClient();
  const { data, error } = templateId === 'new'
    ? await supabase
      .from('task_templates')
      .insert({ ...row, venue_id: user.venueId })
      .select('id')
      .single()
    : await supabase
      .from('task_templates')
      .update(row)
      .eq('id', templateId)
      .select('id')
      .single();

  if (error) return mapWriteError(error);

  // 一覧の対象プラン種別列と T03 の割当名がテンプレート名を参照している
  revalidatePath('/templates');
  revalidatePath('/plan-types');
  return { ok: true, id: (data as { id: string }).id };
}

export default async function TemplateEditPage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;

  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect(landingPathFor(user.role));

  const isNew = templateId === 'new';
  let record: TemplateRecord | null = null;

  if (!isNew) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('task_templates')
      // 文字列連結にすると PostgREST の型推論が効かなくなるため、1つのリテラルで書く
      .select('id, name, description, submission_format, allowed_file_types, default_options, due_offset_days, importance, is_required, active')
      .eq('id', templateId)
      .maybeSingle();

    // 他式場のテンプレートは RLS で 0 行になる。存在しない場合と同じ扱い（4-3 権限エラーの規約）
    if (error || !data) notFound();
    record = data as TemplateRecord;
  }

  const initial: TemplateFormInitial = {
    name: record?.name ?? '',
    description: record?.description ?? '',
    submissionFormat: record?.submission_format ?? 'text',
    allowedFileTypes: record?.allowed_file_types ?? [],
    choices: record?.default_options?.choices ?? [],
    dueOffsetDays: record ? String(record.due_offset_days) : '',
    importance: record?.importance ?? 'normal',
    isRequired: record?.is_required ?? true,
    active: record?.active ?? true,
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
            <Link href="/templates" className="text-link hover:underline">
              宿題テンプレート
            </Link>
          </li>
          <li className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <span aria-current="page">{isNew ? '新規登録' : '編集'}</span>
          </li>
        </ol>
      </nav>

      <h1 className="section-head">
        {isNew ? '宿題テンプレートの新規登録' : `宿題テンプレートの編集：${record?.name ?? ''}`}
      </h1>

      <TemplateForm
        mode={isNew ? 'new' : 'edit'}
        initial={initial}
        save={saveTemplate.bind(null, templateId)}
      />
    </div>
  );
}
