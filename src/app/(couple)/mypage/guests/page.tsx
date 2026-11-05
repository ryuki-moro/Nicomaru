/**
 * ゲストの出欠（couple 向け）。
 *
 * 新郎新婦がゲストへ配る共通の回答URLを発行・表示し、届いた回答を一覧・集計する。
 * 回答URLは case_guest_forms に暗号化して保持しているので、ここで復号して再表示できる。
 * 案件の解決は挙式情報（/mypage/case）と同じく、参照できる案件から挙式日が近いものを主とする。
 */
import Link from 'next/link';

import { GuestResponseList } from '@/components/guests/GuestResponseList';
import { EmptyState } from '@/components/ui/EmptyState';
import { requirePageUser } from '@/lib/auth/session';
import { decryptPii } from '@/lib/crypto';
import { usingD1 } from '@/lib/d1/mode';
import { appBaseUrl } from '@/lib/notify/mailer';
import { buildGuestFormUrl, loadGuestBook, type GuestBook } from '@/lib/services/guests';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { GuestFormLink } from './GuestFormLink';

export const metadata = { title: 'ゲストの出欠' };

const LoadError = () => (
  <div role="alert" className="banner-error">
    <span>情報を読み込めませんでした。時間をおいて開き直してください。</span>
  </div>
);
const Waiting = () => (
  <EmptyState message="担当プランナーが準備を進めています。案件の情報が届くまでお待ちください。" />
);

async function D1CoupleGuests() {
  const user = await requirePageUser('couple');
  const { localDB } = await import('@/lib/d1/runtime');
  const { listCases } = await import('@/lib/d1/cases');
  const { activeGuestFormToken, loadGuestBook: load } = await import('@/lib/d1/guests');
  let caseId: string | undefined;
  let tokenEnc: string | null = null;
  let book: GuestBook | null = null;
  try {
    const db = await localDB();
    caseId = (await listCases(db, user)).items[0]?.id;
    if (caseId) {
      tokenEnc = await activeGuestFormToken(db, user, caseId);
      book = await load(db, user, caseId);
    }
  } catch (error) {
    console.error('[mypage/guests] D1の読み込みに失敗しました', error);
    return <LoadError />;
  }
  if (!caseId) return <Waiting />;
  return <GuestsView caseId={caseId} url={formUrl(tokenEnc)} book={book} />;
}

function formUrl(tokenEnc: string | null | undefined) {
  try {
    const token = decryptPii(tokenEnc);
    return token ? buildGuestFormUrl(appBaseUrl(), token) : null;
  } catch {
    // 鍵の差し替え等で復号できない場合は、未発行として扱い切り替えを促す
    return null;
  }
}

export default async function CoupleGuestsPage() {
  if (usingD1()) return D1CoupleGuests();
  const supabase = await createSupabaseServerClient();

  const { data: weddingCase, error } = await supabase
    .from('wedding_cases')
    .select('id')
    .order('wedding_date', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) return <LoadError />;
  if (!weddingCase) return <Waiting />;

  const [formResult, book] = await Promise.all([
    supabase
      .from('case_guest_forms')
      .select('token_enc')
      .eq('case_id', weddingCase.id)
      .is('revoked_at', null)
      .maybeSingle(),
    loadGuestBook(supabase, weddingCase.id),
  ]);

  return (
    <GuestsView caseId={weddingCase.id} url={formUrl(formResult.data?.token_enc)} book={book} />
  );
}

function GuestsView({
  caseId,
  url,
  book,
}: {
  caseId: string;
  url: string | null;
  book: GuestBook | null;
}) {
  return (
    <div className="flex flex-col gap-[14px]">
      <h1 className="section-head">ゲストの出欠</h1>

      <section className="card flex flex-col gap-3">
        <h2 className="text-label font-bold text-text-primary">回答URL</h2>
        <p className="text-caption text-text-secondary">
          {'ゲストの皆さまにこのURLをお送りください。ゲストはログインせずに、ご出欠・年齢区分・性別・' +
            'おふたりとのご関係・アレルギーや身体的なご事情を回答できます。ご家族などは同伴者としてまとめて回答できます。'}
        </p>
        <GuestFormLink caseId={caseId} url={url} />
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="text-label font-bold text-text-primary">届いた回答</h2>
        {book === null ? (
          <div role="alert" className="banner-error">
            <span>回答を読み込めませんでした。時間をおいて開き直してください。</span>
          </div>
        ) : (
          <GuestResponseList caseId={caseId} book={book} editable />
        )}
        <p className="text-caption text-text-muted">
          回答は担当プランナーにも共有され、お料理や引出物の手配に使われます。
        </p>
      </section>

      <Link href="/mypage/case" className="btn-secondary block text-center">
        挙式情報へ戻る
      </Link>
    </div>
  );
}
