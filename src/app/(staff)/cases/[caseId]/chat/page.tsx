/**
 * 案件チャット（担当者側）。新郎新婦とのやり取りを案件ごとに残す。
 * 一覧の初回分だけをここで読み、以降の更新は ChatPanel が受け持つ。
 */
import { redirect } from 'next/navigation';

import { ChatPanel } from '@/components/chat/ChatPanel';
import { Breadcrumbs, DASHBOARD_CRUMB } from '@/components/layout/Breadcrumbs';
import { requirePageUser } from '@/lib/auth/session';
import { caseRow } from '@/lib/d1/cases';
import { listMessages, MESSAGE_RETRACT_WINDOW_MS } from '@/lib/d1/messages';
import { localDB } from '@/lib/d1/runtime';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'チャット' };

export default async function CaseChatPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const user = await requirePageUser('planner', 'admin', 'system_admin');
  const db = await localDB();
  let weddingCase: Awaited<ReturnType<typeof caseRow>>;
  try {
    weddingCase = await caseRow(db, user, caseId);
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_FOUND') redirect('/error?code=404');
    throw error;
  }
  // アーカイブ済みの案件には投稿できないため、チャットも開かない
  if (weddingCase.archived_at) redirect(`/cases/${caseId}`);
  const coupleName = weddingCase.couple_profiles.map((p) => p.full_name).join('・');
  const { items, hasMore } = await listMessages(db, user, caseId, { limit: 50 });

  return (
    <div>
      <Breadcrumbs
        className="mb-3"
        items={[
          DASHBOARD_CRUMB,
          { label: '案件一覧', href: '/cases' },
          { label: weddingCase.case_code, href: `/cases/${caseId}` },
          { label: 'チャット' },
        ]}
      />
      <h1 className="section-head">チャット</h1>
      <p className="mb-3 mt-1 text-caption text-text-muted">
        {weddingCase.case_code}
        {coupleName && ` / ${coupleName} さま`}
      </p>
      <ChatPanel
        caseId={caseId}
        initialMessages={items}
        initialHasOlder={hasMore}
        retractWindowMs={MESSAGE_RETRACT_WINDOW_MS}
      />
    </div>
  );
}
