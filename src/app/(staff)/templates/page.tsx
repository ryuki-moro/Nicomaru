/**
 * T01 宿題テンプレート一覧（admin）。
 *
 * 正本: 基本設計書 Version 1.2 4-3「T01〜T03 宿題・テンプレート管理」。
 *   T01：宿題テンプレート一覧（テンプレート名・対象プラン種別・逆算日数）。
 *        「新規登録」（T02）、行タップ（T02）。
 *   4-3 一覧画面共通：既定の表示件数は50件、以降はページング。
 *   打ち切るだけでは51件目以降のテンプレートを編集・停止する手段が無くなるため、
 *   K01／M02 と同じく1件多く取って前後リンクを出す。
 *
 * 参照は task_templates_select（自式場のみ）が、更新は task_templates_write（admin のみ）が守る。
 */
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser } from '@/lib/auth/session';
import {
  IMPORTANCE_LABEL,
  LIST_PAGE_SIZE,
  SUBMISSION_FORMAT_LABEL,
  type Importance,
  type SubmissionFormat,
} from '@/lib/constants';
import { resolvePage } from '@/lib/pagination';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { TemplateDraftPanel } from './TemplateDraftPanel';

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
function pageHref(page: number): string {
  return page > 1 ? `/templates?page=${page}` : '/templates';
}
export default async function TemplateListPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string | string[];
  }>;
}) {
  const page = resolvePage((await searchParams).page);
  const user = await getAppUser();
  // テンプレートは式場ごとの運用差を吸収する仕組み（11章）であり、管理者のみが編集する（表4-10 T01）
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/error?code=403');
  const d1Mode = true;
  // 停止中を下に、準備の早いもの（逆算日数の大きいもの）から並べる。同着は id でタイブレーク（4-3 一覧画面共通）
  // 1件多く取り、次ページの有無を件数の追加問い合わせなしで判定する。
  const from = (page - 1) * LIST_PAGE_SIZE;
  const [templatesResult, assignmentsResult, planTypesResult] = [
    { data: null, error: null },
    { data: null },
    { data: null },
  ];
  let fetched: TemplateRow[] = templatesResult.data ?? [];
  let assignments: AssignmentRow[] = assignmentsResult.data ?? [];
  let planTypes: PlanTypeRow[] = planTypesResult.data ?? [];
  let d1HasNext: boolean | null = null;
  {
    const { localDB } = await import('@/lib/d1/runtime');
    const { listTemplatesD1, listPlanTypesD1 } = await import('@/lib/d1/admin');
    const db = await localDB();
    const d1 = await listTemplatesD1(db, user, page);
    fetched = d1.rows.map((r) => ({
      id: r.id,
      name: r.name,
      submission_format: r.submission_format as SubmissionFormat,
      due_offset_days: r.due_offset_days,
      importance: r.importance as Importance,
      is_required: r.is_required,
      active: r.active,
    }));
    d1HasNext = d1.hasNext;
    const plans = await listPlanTypesD1(db, user, 1);
    planTypes = plans.rows.map((pl) => ({ id: pl.id, name: pl.name }));
    const { results: assignRows } = await db
      .prepare('SELECT task_template_id, plan_type_id FROM plan_task_templates')
      .all<AssignmentRow>();
    assignments = assignRows;
  }
  const hasNext = d1HasNext ?? fetched.length > LIST_PAGE_SIZE;
  const templates = fetched.slice(0, LIST_PAGE_SIZE);
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
  const loadFailed = false;
  return (
    <div className="space-y-4">
      <Breadcrumbs items={[DASHBOARD_CRUMB, { label: '宿題テンプレート' }]} />

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

      <TemplateDraftPanel
        existing={templates.map((t) => ({ name: t.name, due_offset_days: t.due_offset_days }))}
      />

      {loadFailed && (
        <p role="alert" className="banner-error">
          テンプレートを読み込めませんでした。画面を更新してからもう一度お試しください。
        </p>
      )}

      {templates.length === 0 && !loadFailed ? (
        <EmptyState
          message={
            page > 1
              ? 'これ以上のテンプレートはありません。'
              : 'まだ宿題テンプレートがありません。「新規登録」から追加してください。'
          }
        />
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
                      <Link href={`/templates/${template.id}`} className="table-link">
                        {template.name}
                      </Link>
                      {!template.is_required && <span className="ml-2 badge-neutral">任意</span>}
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

      {(page > 1 || hasNext) && (
        <nav aria-label="ページ送り" className="flex items-center justify-between">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="btn-ghost">
              前の{LIST_PAGE_SIZE}件
            </Link>
          ) : (
            <span />
          )}
          {hasNext && (
            <Link href={pageHref(page + 1)} className="btn-ghost">
              次の{LIST_PAGE_SIZE}件
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
