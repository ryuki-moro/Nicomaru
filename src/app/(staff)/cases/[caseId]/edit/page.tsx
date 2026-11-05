/**
 * K04 案件変更画面（planner／admin）
 *
 * 正本: 基本設計書 Version 1.2 4-3 K04。
 *   - K03 と同一項目（登録済み値を初期表示。案件番号は変更不可）
 *   - 「担当プランナー」を追加し、自式場の planner から選択する（変更は admin のみ）
 *   - 挙式日・プラン種別の変更時は確定前に差分確認ダイアログ（実装は CaseEditForm）
 */
import { usingD1 } from '@/lib/d1/mode';
import { redirect } from 'next/navigation';

import { CaseEditForm, type CaseEditInitial } from './CaseEditForm';
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { requirePageUser } from '@/lib/auth/session';
import { COUPLE_PROFILE_COLUMNS, type ContactChannel, type PartnerRole } from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface CaseRow {
  id: string;
  case_code: string;
  wedding_date: string;
  wedding_time: string | null;
  contact_channel: ContactChannel;
  guest_count: number | null;
  plan_type_id: string | null;
  primary_planner_id: string;
  archived_at: string | null;
  couple_profiles: {
    partner_role: PartnerRole;
    full_name: string;
    email: string | null;
    is_primary_contact: boolean;
  }[];
}

export default async function CaseEditPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requirePageUser('planner', 'admin', 'system_admin');

  const { caseId } = await params;
  let row: CaseRow;
  let plans: { id: string; name: string }[];
  let planners: { id: string; displayName: string }[] | null = null;
  if (usingD1()) {
    const { localDB } = await import('@/lib/d1/runtime');
    const { caseRow } = await import('@/lib/d1/cases');
    const db = await localDB();
    let venueId: string;
    try {
      const found = await caseRow(db, user, caseId);
      row = found;
      venueId = found.venue_id;
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') redirect('/error');
      throw error;
    }
    if (row.archived_at) redirect(`/cases/${caseId}`);
    plans = (
      await db
        .prepare('SELECT id,name FROM plan_types WHERE venue_id=? AND active=1 ORDER BY name')
        .bind(venueId)
        .all<{ id: string; name: string }>()
    ).results;
    if (user.role === 'admin' || user.role === 'system_admin')
      planners = (
        await db
          .prepare(
            "SELECT p.id,u.name AS displayName FROM user_profiles p JOIN user u ON u.id=p.id WHERE p.venue_id=? AND p.role='planner' AND p.status='active' ORDER BY u.name",
          )
          .bind(venueId)
          .all<{ id: string; displayName: string }>()
      ).results;
  } else {
    const supabase = await createSupabaseServerClient();

    const { data } = await supabase
      .from('wedding_cases')
      .select(
        `id, case_code, wedding_date, wedding_time, contact_channel, guest_count,
       plan_type_id, primary_planner_id, archived_at,
       couple_profiles ( ${COUPLE_PROFILE_COLUMNS} )`,
      )
      .eq('id', caseId)
      .maybeSingle();

    if (!data) redirect('/error?code=404');
    row = data as unknown as CaseRow;
    // アーカイブ済みは内容変更の対象外（K05／2-5）。復元してから編集する導線にする。
    if (row.archived_at !== null) redirect(`/cases/${caseId}`);

    const { data: planData } = await supabase
      .from('plan_types')
      .select('id, name, display_order')
      .eq('active', true)
      .order('display_order', { ascending: true });
    plans = ((planData ?? []) as { id: string; name: string }[]).map((plan) => ({
      id: plan.id,
      name: plan.name,
    }));

    // 担当プランナーの変更は admin のみ（4-3 K04）。planner には選択肢自体を渡さない。
    const isAdmin = user.role === 'admin' || user.role === 'system_admin';

    if (isAdmin) {
      const { data: plannerData } = await supabase
        .from('user_profiles')
        .select('id, display_name, role, status')
        .eq('role', 'planner')
        .eq('status', 'active')
        .order('display_name', { ascending: true });
      planners = ((plannerData ?? []) as { id: string; display_name: string }[]).map((planner) => ({
        id: planner.id,
        displayName: planner.display_name,
      }));
    }
  }
  const groom = row.couple_profiles.find((p) => p.partner_role === 'groom');
  const bride = row.couple_profiles.find((p) => p.partner_role === 'bride');
  const primary = row.couple_profiles.find((p) => p.is_primary_contact);

  const initial: CaseEditInitial = {
    weddingDate: row.wedding_date,
    weddingTime: row.wedding_time ? row.wedding_time.slice(0, 5) : '',
    // 氏名・メールは暗号化列。初期表示のために復号する（13-1）。
    // 読めない値はそのまま表示する（readPii）。未変更の項目は PATCH の対象外なので、
    // プランナーが触らない限り暗号文が再送信されることはない。
    groomName: readPii(groom?.full_name),
    brideName: readPii(bride?.full_name),
    contactEmail: readPii(primary?.email),
    primaryContact: primary?.partner_role ?? 'bride',
    contactChannel: row.contact_channel,
    guestCount: row.guest_count === null ? '' : String(row.guest_count),
    planTypeId: row.plan_type_id ?? '',
    primaryPlannerId: row.primary_planner_id,
  };

  return (
    <div className="space-y-4">
      <Breadcrumbs
        items={[
          DASHBOARD_CRUMB,
          { label: '案件一覧', href: '/cases' },
          { label: row.case_code, href: `/cases/${row.id}` },
          { label: '案件変更' },
        ]}
      />

      <h1 className="section-head">案件変更</h1>

      <CaseEditForm
        caseId={row.id}
        caseCode={row.case_code}
        initial={initial}
        plans={plans}
        planners={planners}
      />
    </div>
  );
}
