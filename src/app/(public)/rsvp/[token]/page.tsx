import type { Metadata } from 'next';

import { PARTNER_ROLE_LABEL, type PartnerRole } from '@/lib/constants';
import { isEncrypted, readPii } from '@/lib/crypto';
import { formatDateJp } from '@/lib/format';
import { GUEST_FORM_TOKEN_PATTERN } from '@/lib/services/guests';
import { hashInvitationToken } from '@/lib/services/invitations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

import { GuestResponseForm } from './GuestResponseForm';

export const metadata: Metadata = { title: 'ご出欠のご回答', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

interface PeekRow {
  wedding_date: string;
  groom_name_enc: string | null;
  bride_name_enc: string | null;
}

/**
 * ゲストの出欠回答画面（未ログイン）。
 * 新郎新婦が配った共通URLから開く。表示するのは挙式日と新郎新婦の氏名だけで、
 * 回答の登録と最終的なURLの照合は POST /api/rsvp/{token} が行う。
 */
export default async function GuestRsvpPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (process.env.NICOMARU_DB === 'd1-local') return <Unavailable />;
  if (!GUEST_FORM_TOKEN_PATTERN.test(token)) return <InvalidForm />;

  const admin = createSupabaseAdminClient('guest.rsvp');
  const { data, error } = await admin.rpc('peek_guest_form', {
    p_token_hash: hashInvitationToken(token),
  });
  if (error) return <Unavailable />;
  const form = (data as PeekRow[] | null)?.[0];
  if (!form) return <InvalidForm />;

  // 氏名は暗号化列（13-1）。復号できない値はゲストに見せず、区分名だけにする
  const name = (stored: string | null) => {
    const value = readPii(stored);
    return value && !isEncrypted(value) ? value : null;
  };
  const partnerNames: Record<PartnerRole, string | null> = {
    groom: name(form.groom_name_enc),
    bride: name(form.bride_name_enc),
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="card-hero">
        <p className="text-label text-primary-dark">ご出欠のご回答</p>
        <h1 className="mt-1 text-title font-bold text-primary-darker">
          {partnerNames.groom && partnerNames.bride
            ? `${partnerNames.groom}・${partnerNames.bride}の結婚式`
            : '結婚式のご案内'}
        </h1>
        <p className="mt-1 text-label text-primary-dark">{formatDateJp(form.wedding_date)}</p>
      </div>
      <p className="text-label text-text-secondary">
        {'お手数ですが、ご出欠と当日のご準備に必要な事項をお知らせください。' +
          'ご家族などでご一緒に出席される方は、同伴者としてまとめてご回答いただけます。'}
      </p>
      <GuestResponseForm
        token={token}
        sideLabels={{
          groom: partnerNames.groom
            ? `${PARTNER_ROLE_LABEL.groom}（${partnerNames.groom}）側`
            : `${PARTNER_ROLE_LABEL.groom}側`,
          bride: partnerNames.bride
            ? `${PARTNER_ROLE_LABEL.bride}（${partnerNames.bride}）側`
            : `${PARTNER_ROLE_LABEL.bride}側`,
        }}
      />
    </div>
  );
}

function InvalidForm() {
  return (
    <div className="space-y-4">
      <h1 className="section-head">この回答URLは使えません</h1>
      <p className="text-label text-text-secondary">
        URLが切り替えられたか、受付が終了しています。お手数ですが、新郎新婦へ新しいURLをお問い合わせください。
      </p>
    </div>
  );
}

function Unavailable() {
  return (
    <div role="alert" className="banner-error">
      <span>回答画面を表示できませんでした。時間をおいて開き直してください。</span>
    </div>
  );
}
