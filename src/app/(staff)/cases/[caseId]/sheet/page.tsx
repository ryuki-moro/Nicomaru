/**
 * D03 打ち合わせ前準備シート（planner、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 D03／機能4-5／6-11／表5-21。
 *
 *   「提出済／未提出サマリー、直近の連絡履歴タイムライン、フォロー記録。
 *     AI補助（9-2 要点下書き）を利用可。「印刷する」「PDF出力」。
 *     生成したPDFは storage_files.visibility='planner_only' を既定とし、
 *     couple からは参照できない（6-11）」
 *
 * 【出力手段】
 * 6-11 は「第一手段をブラウザ印刷（印刷用CSS）とし、PDFファイルが必要な場合は
 * @react-pdf/renderer 等の軽量ライブラリでサーバー側生成」と定める。
 * ここでは第一手段の印刷を実装する。ブラウザの「PDFとして保存」でファイル化もできるため、
 * Vercel Hobby のバンドルサイズ・実行時間の制約（2-2-1）を増やさずに要件を満たせる。
 * サーバー側生成は、印刷では足りないと分かってから足す。
 *
 * AI補助（9-2 要点下書き）は、依頼をサーバーアクションで投入し、
 * 生成の監視と採用・破棄を SheetDraftPanel（クライアント）が担う。
 * LLM へ渡す内容はサーバー側で組み立てる（7-4 の入力最小化）。
 * 採用されたものだけが印刷対象のシート本体へ載る（7-1 の確認前提）。
 *
 * 【なぜ生成のたびに meeting_sheets へ残すか】
 * 表5-21 の summary_json は「生成時点の集約内容」。
 * 打ち合わせの場で見た内容を後から再現できないと、
 * 「あのとき何が未提出だったか」を追えなくなる（D03 は打ち合わせの根拠資料）。
 */
import { requirePageUser } from '@/lib/auth/session';
import { type FollowMethod, type TaskStatus } from '@/lib/constants';
import { MeetingSheetPageD1 } from './SheetPageD1';
export const dynamic = 'force-dynamic';
interface FollowRow {
  id: string;
  method: FollowMethod;
  note: string | null;
  followed_at: string;
  user_profiles: {
    display_name: string;
  } | null;
}
interface CommRow {
  id: string;
  channel: string;
  direction: string;
  source: string;
  summary: string;
  occurred_at: string;
}
export default async function MeetingSheetPage({
  params,
}: {
  params: Promise<{
    caseId: string;
  }>;
}) {
  const pageUser = await requirePageUser();
  const { caseId } = await params;
  {
    return <MeetingSheetPageD1 caseId={caseId} user={pageUser} />;
  }
}
function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
