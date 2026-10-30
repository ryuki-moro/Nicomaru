/**
 * K03 案件登録画面（planner）
 *
 * 正本: 基本設計書 Version 1.2 3-3-2「2-1 案件登録」／4-3 K03 表4-14。
 *
 * プラン種別の選択肢と割当宿題プレビューの元データ（plan_task_templates → task_templates）を
 * Server Component で読み込み（6-5 の直アクセス原則）、入力と送信だけをクライアントへ渡す。
 */

import { usingD1 } from '@/lib/d1/mode';
import { CaseForm, type PlanOption } from './CaseForm';
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { EmptyState } from '@/components/ui/EmptyState';
import { requirePageUser } from '@/lib/auth/session';
import { todayInJst } from '@/lib/format';
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
  // K03 は planner の画面（4-1 表4-10）。API は admin も許可するため admin の直接遷移は通す。
  const user = await requirePageUser('planner', 'admin');

  let plans: PlanOption[];
  let error = false;
  if (usingD1()) {
    const { localDB } = await import('@/lib/d1/runtime');
    const result = await (
      await localDB()
    )
      .prepare(
        'SELECT id,name,templates_json FROM plan_types WHERE venue_id=? AND active=1 ORDER BY name',
      )
      .bind(user.venueId)
      .all<{ id: string; name: string; templates_json: string }>();
    plans = result.results.map((plan) => ({
      id: plan.id,
      name: plan.name,
      templates: (
        JSON.parse(plan.templates_json) as import('@/lib/services/schedule').TemplateForAssign[]
      ).map((t) => ({
        id: t.taskTemplateId,
        name: t.title,
        dueOffsetDays: t.dueOffsetDaysOverride ?? t.dueOffsetDays,
      })),
    }));
  } else {
    const supabase = await createSupabaseServerClient();
    const { data, error: loadError } = await supabase
      .from('plan_types')
      .select(
        `id, name, display_order,
       plan_task_templates ( display_order, due_offset_days_override,
                             task_templates ( id, name, due_offset_days, active ) )`,
      )
      .eq('active', true)
      .order('display_order', { ascending: true });

    error = Boolean(loadError);
    plans = ((data ?? []) as unknown as PlanTypeRow[]).map((plan) => ({
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
  }
  // 過去日付不可（表4-14）の基準日。サーバー側 validation.ts の notPastDate と同じ
  // 日本時間の暦日を使う。片方が UTC だと JST の 0:00〜9:00 に入力欄と検証結果が食い違う。
  const today = todayInJst();

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[DASHBOARD_CRUMB, { label: '案件一覧', href: '/cases' }, { label: '案件登録' }]}
      />

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
