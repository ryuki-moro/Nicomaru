/**
 * D05 打ち合わせ記録・宿題起票（planner、Phase 3）。
 *
 * 正本: 基本設計書 4-3 D05／7-2 の 9-5／7-3。
 *
 *   「打ち合わせメモ・ヒアリングメモを入力（meeting_notes）。
 *     AI（9-5）が抽出した宿題起票案（宿題名・説明・期限の目安）を
 *     『AIによる起票案（要確認）』として提示。
 *     プランナーが承認・修正した案のみ宿題（case_tasks）として登録」
 *
 * 記録の保存とジョブ投入はサーバーアクションで行う（7-3「打ち合わせ記録登録を契機とする
 * ジョブは…サーバー側処理から内部呼び出しで投入」）。
 * 起票案の確認・登録は TaskProposalPanel（クライアント）が担う。
 *
 * D04 フォロー記録とは別の画面。D04 は「連絡したこと」の記録で、
 * こちらは「打ち合わせで決まったこと」の記録。宿題の元になるのは後者。
 */
import { requirePageUser } from '@/lib/auth/session';
import { demoLogin } from '@/lib/d1/mode';
import { MeetingNotesPageD1 } from './MeetingNotesPageD1';
export const dynamic = 'force-dynamic';
export default async function MeetingNotesPage({
  params,
  searchParams,
}: {
  params: Promise<{
    caseId: string;
  }>;
  searchParams: Promise<{ memo?: string }>;
}) {
  // couple には打ち合わせ記録そのものを見せない（付録A meeting_notes_all は staff 限定）
  const pageUser = await requirePageUser('planner', 'admin', 'system_admin');
  const { caseId } = await params;
  // npm run demo だけ: ?memo=demo で、発表用の打ち合わせメモを入力済みにして開く
  const memo =
    demoLogin() && (await searchParams).memo === 'demo' ? process.env.DEMO_MEETING_MEMO : undefined;
  return <MeetingNotesPageD1 caseId={caseId} user={pageUser} initialMemo={memo} />;
}
