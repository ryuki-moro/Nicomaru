/**
 * M06 アカウント設定・LINE紐付け（couple、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 4-3 M06／機能1-3／6-10。
 *
 *   「プロフィール表示。LINE友だち追加への導線と紐付け状態表示。
 *     紐付け完了後は重要通知が LINE で届く（未紐付けはメール）」
 *   「M06 の「LINE紐付け」導線はこの nonce 発行画面として実装する」（6-10 手順(3)）
 *
 * 公式LINEで友だち追加すると、Bot が linkToken 付きのURLでこの画面へ案内する。
 * その linkToken を持って開かれたときだけ「連携する」を出す。
 * linkToken が無い状態で開かれた場合は、先に友だち追加してもらう案内を出す。
 */

import { requirePageUser } from '@/lib/auth/session';
import { COUPLE_PROFILE_COLUMNS, PARTNER_ROLE_LABEL, type PartnerRole } from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await requirePageUser();

  const supabase = await createSupabaseServerClient();
  const profileResult = await supabase
    .from('couple_profiles')
    .select(COUPLE_PROFILE_COLUMNS)
    .eq('user_profile_id', user.id)
    .maybeSingle();

  const profile = profileResult.data as unknown as {
    partner_role: PartnerRole;
    full_name: string;
    email: string | null;
  } | null;

  return (
    <div className="space-y-5">
      <h1 className="section-head">アカウント</h1>

      <section className="card space-y-2">
        <h2 className="text-label font-bold text-text-primary">ご登録の内容</h2>
        <dl className="space-y-2 text-label">
          <div>
            <dt className="text-caption text-text-muted">お名前</dt>
            <dd>{user.displayName}</dd>
          </div>
          {profile && (
            <div>
              <dt className="text-caption text-text-muted">区分</dt>
              <dd>{PARTNER_ROLE_LABEL[profile.partner_role] ?? '—'}</dd>
            </div>
          )}
          <div>
            <dt className="text-caption text-text-muted">メールアドレス</dt>
            <dd>{profile?.email ? readPii(profile.email) : user.email}</dd>
          </div>
        </dl>
        <p className="text-caption text-text-muted">
          ご登録内容の変更は、担当プランナーへお知らせください。
        </p>
      </section>
    </div>
  );
}
