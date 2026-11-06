/**
 * 席次（couple 向け、#181・D1版）。
 *
 * プランナーから届いた配置パターンから1つ選び、確認済みの出席者を卓に割り当てて提出する。
 * 案件の解決はゲストの出欠（/mypage/guests）と同じく、参照できる案件から挙式日が近いものを主とする。
 */
import { SeatingChartEditor } from '@/components/seating/SeatingChartEditor';
import { EmptyState } from '@/components/ui/EmptyState';
import { requirePageUser } from '@/lib/auth/session';
import { AUTO_GUEST_TAGS, customTagKey } from '@/lib/guest-tags';
import { seatGuestsFromBook } from '@/lib/seating/guests';
import Link from 'next/link';
export const metadata = { title: '席次' };
const LoadError = () => (
  <div role="alert" className="banner-error">
    <span>情報を読み込めませんでした。時間をおいて開き直してください。</span>
  </div>
);
const Waiting = () => (
  <EmptyState message="担当プランナーが準備を進めています。案件の情報が届くまでお待ちください。" />
);
async function D1CoupleSeating() {
  const user = await requirePageUser('couple');
  const { localDB } = await import('@/lib/d1/runtime');
  const { listCases } = await import('@/lib/d1/cases');
  const { loadGuestBook: loadBook } = await import('@/lib/d1/guests');
  const { loadSeatingChart, loadSeatingLayouts } = await import('@/lib/d1/seating');
  let data: {
    caseId: string;
    layouts: Awaited<ReturnType<typeof loadSeatingLayouts>>;
    chart: Awaited<ReturnType<typeof loadSeatingChart>>;
    guests: ReturnType<typeof seatGuestsFromBook>['guests'];
    info: ReturnType<typeof seatGuestsFromBook>['info'];
    tagLabels: Record<string, string>;
  } | null = null;
  let waiting = false;
  try {
    const db = await localDB();
    const caseId = (await listCases(db, user)).items[0]?.id;
    if (!caseId) {
      waiting = true;
    } else {
      const [layouts, chart, guestBook] = await Promise.all([
        loadSeatingLayouts(db, user, caseId),
        loadSeatingChart(db, user, caseId),
        loadBook(db, user, caseId),
      ]);
      const { guests, info } = seatGuestsFromBook(guestBook);
      data = {
        caseId,
        layouts,
        chart,
        guests,
        info,
        tagLabels: {
          ...Object.fromEntries(AUTO_GUEST_TAGS.map((t) => [t.key, t.label])),
          ...Object.fromEntries(guestBook.tags.map((t) => [customTagKey(t.id), t.name])),
        },
      };
    }
  } catch (error) {
    console.error('[mypage/seating] D1の読み込みに失敗しました', error);
    return <LoadError />;
  }
  if (waiting || !data) return <Waiting />;
  return (
    <div className="flex flex-col gap-[14px]">
      <h1 className="section-head">席次</h1>
      <SeatingChartEditor
        caseId={data.caseId}
        layouts={data.layouts}
        guests={data.guests}
        info={data.info}
        tagLabels={data.tagLabels}
        chart={data.chart}
      />
      <Link href="/mypage/guests" className="btn-secondary block text-center">
        ゲストの出欠へ戻る
      </Link>
    </div>
  );
}
export default async function CoupleSeatingPage() {
  return D1CoupleSeating();
}
