/**
 * K03 案件登録画面（planner）
 *
 * 正本: 基本設計書 Version 1.2 3-3-2「2-1 案件登録」／4-3 K03 表4-14。
 *
 * プラン種別の選択肢と割当宿題プレビューの元データ（plan_task_templates → task_templates）を
 * Server Component で読み込み（6-5 の直アクセス原則）、入力と送信だけをクライアントへ渡す。
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CaseForm, type PlanOption } from './CaseForm';
import { EmptyState } from '@/components/ui/EmptyState';
import { getAppUser } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PlanTypeRow {
  id: string;
  name: string;
  display_order: number;
  plan_task_templates: {
    display_order: number;
    due_offset_days_override: number | null;
    task_templates: { id: string; name: string; due_offset_days: number; active: boolean } | null;
  }[];
}

export default async function CaseCreatePage() {
  const user = await getAppUser();
  if (!user) redirect('/login');
  // K03 は planner の画面（4-1 表4-10）。API は admin も許可するため admin の直接遷移は通す。
  if (user.role !== 'planner' && user.role !== 'admin') redirect('/cases');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('plan_types')
    .select(
      `id, name, display_order,
       plan_task_templates ( display_order, due_offset_days_override,
                             task_templates ( id, name, due_offset_days, active ) )`,
    )
    .eq('active', true)
    .order('display_order', { ascending: true });

  const plans: PlanOption[] = ((data ?? []) as unknown as PlanTypeRow[]).map((plan) => ({
    id: plan.id,
    name: plan.name,
    templates: plan.plan_task_templates
      .filter((link) => link.task_templates !== null && link.task_templates.active)
      .sort((a, b) => a.display_order - b.display_order)
      .map((link) => {
        const template = link.task_templates as NonNullable<typeof link.task_templates>;
        return {
          id: template.id,
          name: template.name,
          // プラン固有の上書きがあればそちらを使う（6-6-2）
          dueOffsetDays: link.due_offset_days_override ?? template.due_offset_days,
        };
      }),
  }));

  // 過去日付不可の判定（表4-14）はサーバー側 validation.ts と同じ UTC 基準の日付で揃える
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <nav aria-label="パンくず">
        <ol className="flex flex-wrap items-center gap-1 text-caption text-text-muted">
          <li>
            <Link href="/dashboard" className="text-link hover:underline">
              ダッシュボード
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href="/cases" className="text-link hover:underline">
              案件一覧
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">案件登録</li>
        </ol>
      </nav>

      <h1 className="section-head">案件登録</h1>

      {error && (
        <div role="alert" className="banner-error">
          <span>プラン種別を取得できませんでした。時間をおいてもう一度お試しください。</span>
        </div>
      )}

      {!error && plans.length === 0 ? (
        <EmptyState message="利用できるプラン種別がありません。式場管理者にプラン種別の登録をご依頼ください。" />
      ) : (
        <CaseForm plans={plans} today={today} />
      )}
    </div>
  );
}
