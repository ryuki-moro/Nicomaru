/**
 * 席次（couple 向け、#181）。
 *
 * プランナーから届いた卓の配置パターンを選び、出席で確認済みのゲストを卓に入れて、プランナーへ提出する。
 * 案件の解決は「ゲストの出欠」（/mypage/guests）と同じく、挙式日が近い案件を主とする。
 */
import Link from 'next/link';

import { SeatingChartEditor } from '@/components/seating/SeatingChartEditor';
import { EmptyState } from '@/components/ui/EmptyState';
import { AUTO_GUEST_TAGS, customTagKey } from '@/lib/guest-tags';
import { seatGuestsFromBook } from '@/lib/seating/guests';
import { loadGuestBook } from '@/lib/services/guests';
import { loadSeatingChart } from '@/lib/services/seating-charts';
import { loadSeatingLayouts } from '@/lib/services/seating-layouts';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: '席次' };

export default async function CoupleSeatingPage() {
  const supabase = await createSupabaseServerClient();

  const { data: weddingCase, error } = await supabase
    .from('wedding_cases')
    .select('id')
    .order('wedding_date', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return (
      <div role="alert" className="banner-error">
        <span>情報を読み込めませんでした。時間をおいて開き直してください。</span>
      </div>
    );
  }
  if (!weddingCase) {
    return (
      <EmptyState message="担当プランナーが準備を進めています。案件の情報が届くまでお待ちください。" />
    );
  }

  const [layouts, book, chart] = await Promise.all([
    loadSeatingLayouts(supabase, weddingCase.id),
    loadGuestBook(supabase, weddingCase.id),
    loadSeatingChart(supabase, weddingCase.id),
  ]);

  const tagLabels: Record<string, string> = Object.fromEntries([
    ...AUTO_GUEST_TAGS.map((tag) => [tag.key, tag.label]),
    ...(book?.tags ?? []).map((tag) => [customTagKey(tag.id), tag.name]),
  ]);
  const seatGuests = book ? seatGuestsFromBook(book) : null;

  return (
    <div className="flex flex-col gap-[14px]">
      <h1 className="section-head">席次</h1>

      <section className="card flex flex-col gap-3">
        {layouts === null || seatGuests === null || chart === null ? (
          <div role="alert" className="banner-error">
            <span>席次を読み込めませんでした。時間をおいて開き直してください。</span>
          </div>
        ) : (
          <SeatingChartEditor
            caseId={weddingCase.id}
            layouts={layouts}
            guests={seatGuests.guests}
            info={seatGuests.info}
            tagLabels={tagLabels}
            chart={chart}
          />
        )}
      </section>

      <Link href="/mypage/guests" className="btn-secondary block text-center">
        ゲストの出欠へ戻る
      </Link>
    </div>
  );
}
