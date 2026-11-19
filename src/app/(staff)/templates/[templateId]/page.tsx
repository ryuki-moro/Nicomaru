/**
 * T02 宿題テンプレート登録・編集（admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 表4-17。
 * URL の templateId が 'new' のときは新規登録、UUID のときは編集として扱う。
 *
 * 6-5 の原則により、テンプレート管理は Route Handler を作らず
 * 「admin かつ自式場」を保証するため、API 層で式場境界を再実装しない。
 * 書き込みは Server Action に置き、秘匿値やエラー写像をブラウザへ持ち出さない。
 */
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { getAppUser } from '@/lib/auth/session';
import { type AllowedFileType, type Importance, type SubmissionFormat } from '@/lib/constants';
import { ApiError, fromPostgresError } from '@/lib/errors';
import { taskTemplateSchema, toErrorDetails } from '@/lib/validation';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { TemplateForm, type SaveTemplateResult, type TemplateFormInitial } from './TemplateForm';
interface TemplateRecord {
  id: string;
  name: string;
  description: string | null;
  submission_format: SubmissionFormat;
  allowed_file_types: AllowedFileType[] | null;
  default_options: {
    choices?: string[];
  } | null;
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
  {
    try {
      const { localDB } = await import('@/lib/d1/runtime');
      const { saveTemplateD1 } = await import('@/lib/d1/admin');
      const saved = await saveTemplateD1(await localDB(), user, templateId, input);
      revalidatePath('/templates');
      revalidatePath('/plan-types');
      return { ok: true, id: saved.id };
    } catch (e) {
      if (e instanceof ApiError)
        return { ok: false, code: e.code, message: e.message, details: e.details ?? [] };
      throw e;
    }
  }
}
export default async function TemplateEditPage({
  params,
}: {
  params: Promise<{
    templateId: string;
  }>;
}) {
  const { templateId } = await params;
  const user = await getAppUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/error?code=403');
  const isNew = templateId === 'new';
  let record: TemplateRecord | null = null;
  if (!isNew) {
    const { localDB } = await import('@/lib/d1/runtime');
    const { getTemplateD1 } = await import('@/lib/d1/admin');
    const found = await getTemplateD1(await localDB(), user, templateId);
    if (!found) notFound();
    record = {
      id: found.id,
      name: found.name,
      description: found.description,
      submission_format: found.submission_format as SubmissionFormat,
      allowed_file_types: found.allowed_file_types as AllowedFileType[],
      default_options: found.default_options as {
        choices?: string[];
      },
      due_offset_days: found.due_offset_days,
      importance: found.importance as Importance,
      is_required: found.is_required,
      active: found.active,
    };
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
      <Breadcrumbs
        items={[
          DASHBOARD_CRUMB,
          { label: '宿題テンプレート', href: '/templates' },
          { label: isNew ? '新規登録' : '編集' },
        ]}
      />

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
