/**
 * T01 宿題テンプレート一覧（admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3「T01〜T03 宿題・テンプレート管理」。
 *   T01：宿題テンプレート一覧（テンプレート名・対象プラン種別・逆算日数）。
 *        「新規登録」（T02）、行タップ（T02）。
 *
 * 6-5 の原則により、本画面は API を経由せず Supabase クライアント（RLS適用）で直接読む。
 * 参照は task_templates_select（自式場のみ）が、更新は task_templates_write（admin のみ）が守る。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser, landingPathFor } from '@/lib/auth/session';
import {
  IMPORTANCE_LABEL,
  LIST_PAGE_SIZE,
  SUBMISSION_FORMAT_LABEL,
  type Importance,
  type SubmissionFormat,
} from '@/lib/constants';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface TemplateRow {
  id: string;
  name: string;
  submission_format: SubmissionFormat;
  due_offset_days: number;
  importance: Importance;
  is_required: boolean;
  active: boolean;
}

interface AssignmentRow {
  task_template_id: string;
  plan_type_id: string;
}

interface PlanTypeRow {
  id: string;
  name: string;
}

/**
 * 逆算日数の表示（表4-17「挙式日から何日前を期限とするか」）。
 * page.tsx は既定 export 以外の named export を Next.js の型検査が許さないため、
 * この画面のローカル関数として持つ。
 */
function formatDueOffset(days: number): string {
  return days === 0 ? '挙式日当日' : `挙式日の${days}日前`;
}

export default async function TemplateListPage() {
  const user = await getAppUser();
  // テンプレートは式場ごとの運用差を吸収する仕組み（11章）であり、管理者のみが編集する（表4-10 T01）
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect(landingPathFor(user.role));

  const supabase = await createSupabaseServerClient();

  // 停止中を下に、準備の早いもの（逆算日数の大きいもの）から並べる。同着は id でタイブレーク（4-3 一覧画面共通）
  const [templatesResult, assignmentsResult, planTypesResult] = await Promise.all([
    supabase
      .from('task_templates')
      .select('id, name, submission_format, due_offset_days, importance, is_required, active')
      .order('active', { ascending: false })
      .order('due_offset_days', { ascending: false })
      .order('name')
      .order('id')
      .limit(LIST_PAGE_SIZE),
    supabase.from('plan_task_templates').select('task_template_id, plan_type_id'),
    supabase.from('plan_types').select('id, name'),
  ]);

  const templates: TemplateRow[] = templatesResult.data ?? [];
  const assignments: AssignmentRow[] = assignmentsResult.data ?? [];
  const planTypes: PlanTypeRow[] = planTypesResult.data ?? [];

  // PostgREST の埋め込み（!inner 等）に頼らず JS 側で突き合わせる。件数が小さく、
  // 埋め込み名の揺れで一覧が落ちるリスクを避けたいため（6-4 の想定規模は式場あたり数十件）
  const planTypeName = new Map(planTypes.map((p) => [p.id, p.name]));
  const planNamesByTemplate = new Map<string, string[]>();
  for (const a of assignments) {
    const name = planTypeName.get(a.plan_type_id);
    if (!name) continue;
    const list = planNamesByTemplate.get(a.task_template_id) ?? [];
    list.push(name);
    planNamesByTemplate.set(a.task_template_id, list);
  }

  const loadFailed = templatesResult.error != null;

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
            <span aria-current="page">宿題テンプレート</span>
          </li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="section-head">宿題テンプレート</h1>
        <div className="flex items-center gap-3">
          <Link href="/plan-types" className="btn-ghost">
            プラン種別管理
          </Link>
          <Link href="/templates/new" className="btn-primary w-auto">
            新規登録
          </Link>
        </div>
      </div>

      <p className="banner-info">
        ここで登録した宿題は、案件登録時にプラン種別ごとのセットとして割り当てられます。
        「利用中」をオフにしても、すでに割り当て済みの案件の宿題はそのまま残ります。
      </p>

      {loadFailed && (
        <p role="alert" className="banner-error">
          テンプレートを読み込めませんでした。画面を更新してからもう一度お試しください。
        </p>
      )}

      {templates.length === 0 && !loadFailed ? (
        <EmptyState message="まだ宿題テンプレートがありません。「新規登録」から追加してください。" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">宿題名</th>
                <th scope="col">対象プラン種別</th>
                <th scope="col">逆算日数</th>
                <th scope="col">提出フォーマット</th>
                <th scope="col">重要度</th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => {
                const planNames = planNamesByTemplate.get(template.id) ?? [];
                return (
                  <tr key={template.id}>
                    <td>
                      <Link
                        href={`/templates/${template.id}`}
                        className="text-link hover:underline"
                      >
                        {template.name}
                      </Link>
                      {!template.is_required && (
                        <span className="ml-2 badge-neutral">任意</span>
                      )}
                    </td>
                    <td className={planNames.length === 0 ? 'text-text-muted' : undefined}>
                      {planNames.length === 0 ? '未割当' : planNames.join('／')}
                    </td>
                    <td>{formatDueOffset(template.due_offset_days)}</td>
                    <td>{SUBMISSION_FORMAT_LABEL[template.submission_format]}</td>
                    <td>{IMPORTANCE_LABEL[template.importance]}</td>
                    <td>
                      <span className={template.active ? 'badge-success' : 'badge-neutral'}>
                        {template.active ? '利用中' : '停止中'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
