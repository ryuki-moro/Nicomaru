import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAppUser } from '@/lib/auth/session';
import {
  hashInvitationToken,
  invitationState,
  invitationLanding,
  type InvitationRow,
} from '@/lib/services/invitations';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { RegisterForm } from './RegisterForm';

export const metadata: Metadata = { title: '初回登録' };
export const dynamic = 'force-dynamic';

/** P02の先読みは案内だけ。消費・宛先照合の最終判定はinitial-registerの原子処理に任せる。 */
export default async function RegisterPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return <InvalidInvitation />;
  const admin = createSupabaseAdminClient('auth.invitation-peek');
  const { data, error } = await admin
    .from('case_invitations')
    .select('expires_at, used_at, revoked_at, use_count, max_uses, case_id, target_partner_role')
    .eq('token_hash', hashInvitationToken(token))
    .eq('purpose', 'initial_registration')
    .maybeSingle();
  if (error)
    return (
      <div role="alert" className="banner-error">
        招待の状態を確認できませんでした。時間をおいて開き直してください。
      </div>
    );
  const invitation = data as
    (InvitationRow & { case_id: string; target_partner_role: string }) | null;
  if (!invitation) return <InvalidInvitation />;
  const state = invitationState(invitation);
  if (invitationLanding(state, false) === 'invalid') return <InvalidInvitation />;
  const user = await getAppUser();
  let ownsInvitation = false;
  if (state === 'used' && user?.role === 'couple') {
    const client = await createSupabaseServerClient();
    const profile = await client
      .from('couple_profiles')
      .select('case_id, partner_role')
      .eq('user_profile_id', user.id)
      .eq('case_id', invitation.case_id)
      .eq('partner_role', invitation.target_partner_role)
      .maybeSingle();
    ownsInvitation = !profile.error && Boolean(profile.data);
  }
  const landing = invitationLanding(state, ownsInvitation);
  if (landing === 'mypage') redirect('/mypage');
  if (landing === 'invalid') return <InvalidInvitation />;
  if (landing === 'registered')
    return (
      <div className="space-y-4">
        <h1 className="section-head">このURLは登録済みです</h1>
        <Link href="/login?next=/mypage" className="btn-primary">
          ログインへ
        </Link>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold text-text-primary">はじめての設定</h1>
        <p className="mt-1 text-label text-text-muted">
          あと少しで、おふたりの準備ページが使えるようになります。
        </p>
      </div>
      {user && (
        <div role="status" className="banner-info">
          {user.displayName}としてログイン中です。このURLのご本人が登録してください。
        </div>
      )}
      <div role="status" className="banner-info">
        <span>
          プランナーからお送りした招待URLです。挙式日やお名前などの情報は登録済みですので、ご連絡先だけご入力ください。パスワードの設定は不要です。
        </span>
      </div>
      <RegisterForm token={token} />
    </div>
  );
}
function InvalidInvitation() {
  return (
    <div className="space-y-4">
      <h1 className="section-head">有効期限が切れているか無効です</h1>
      <p>プランナーへ再発行をご依頼ください。</p>
    </div>
  );
}
