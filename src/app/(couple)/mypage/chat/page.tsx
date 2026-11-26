/**
 * 案件チャット（新郎新婦側）。担当プランナーとのやり取りを残す。
 * 見える案件は付録A の範囲（自分の案件）だけ。複数ある場合は M01 と同じく先頭の案件を主とする。
 */
import { ChatPanel } from '@/components/chat/ChatPanel';
import { EmptyState } from '@/components/ui/EmptyState';
import { requirePageUser } from '@/lib/auth/session';
import { listCases } from '@/lib/d1/cases';
import { listMessages, MESSAGE_RETRACT_WINDOW_MS } from '@/lib/d1/messages';
import { localDB } from '@/lib/d1/runtime';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'チャット' };

export default async function CoupleChatPage() {
  const user = await requirePageUser('couple');
  const db = await localDB();
  const caseId = (await listCases(db, user)).items[0]?.id;
  if (!caseId) {
    return (
      <div className="space-y-4">
        <h1 className="section-head">チャット</h1>
        <EmptyState message="担当プランナーが準備を進めています。案件の情報が届くまでお待ちください。" />
      </div>
    );
  }
  const { items, hasMore } = await listMessages(db, user, caseId, { limit: 50 });

  return (
    <div className="space-y-3">
      <h1 className="section-head">チャット</h1>
      <p className="text-caption text-text-muted">担当プランナーとのやり取りです。</p>
      <ChatPanel
        caseId={caseId}
        initialMessages={items}
        initialHasOlder={hasMore}
        retractWindowMs={MESSAGE_RETRACT_WINDOW_MS}
      />
    </div>
  );
}
