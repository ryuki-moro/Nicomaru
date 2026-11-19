/**
 * K02 案件詳細（couple 向け）。
 *
 * 正本: 基本設計書 Version 1.2 表4-10 K02（主な利用者 planner／admin／couple・Phase 1）、
 * 表9 機能2-3「案件詳細表示」（利用者に couple を含む・Phase 1）、4-3 K02。
 *
 *   - 表示するのは「基本情報（案件番号・挙式日・新郎新婦氏名・人数・プラン種別）」と「宿題進捗」だけ。
 *   - 4-3 K02 が招待状況セクションと宿題一覧セクションを planner／admin に限って
 *     「couple には本セクションの操作を表示しない」と書き分けているのは、
 *     基本情報と宿題進捗は couple にも見せる前提だからである。よって招待の発行・再発行、
 *     宿題の期限変更・対応不要化はここに出さない（操作はもちろん状態も出さない）。
 *   - リスクスコアは 4-3 K02 で「couple には非表示」かつ Phase 2 のため参照もしない。
 *   - couple_profiles.memo は列レベル権限で authenticated から剥奪済み（付録A／6-3-3）。
 *     COUPLE_PROFILE_COLUMNS で select するので、担当プランナー向けの memo は自然に落ちる。
 *
 * couple が見られるのは自分の案件だけ（付録A accessible_case_ids()）なので、
 * M01 と同じくパスに caseId を取らず、参照できる案件から挙式日が近いものを主として解決する。
 */
import { EmptyState } from '@/components/ui/EmptyState';
import { requirePageUser } from '@/lib/auth/session';
import {
  INCOMPLETE_TASK_STATUSES,
  PARTNER_ROLES,
  PARTNER_ROLE_LABEL,
  type PartnerRole,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { formatDateJp } from '@/lib/format';
import Link from 'next/link';
export const metadata = { title: '挙式情報' };
interface CaseRow {
  id: string;
  case_code: string;
  wedding_date: string;
  wedding_time: string | null;
  guest_count: number | null;
  plan_types: {
    name: string;
  } | null;
}
interface ProfileRow {
  partner_role: PartnerRole;
  full_name: string | null;
}
async function D1CoupleCase() {
  const user = await requirePageUser('couple');
  const { localDB } = await import('@/lib/d1/runtime');
  const { listCases, caseRow } = await import('@/lib/d1/cases');
  let row;
  try {
    const db = await localDB();
    const id = (await listCases(db, user)).items[0]?.id;
    row = id ? await caseRow(db, user, id) : null;
  } catch (error) {
    console.error('[mypage/case] D1の読み込みに失敗しました', error);
    return <LoadError />;
  }
  if (!row) return <Waiting />;
  const incomplete = row.case_tasks.filter((t) => INCOMPLETE_TASK_STATUSES.includes(t.status));
  return (
    <CaseView
      weddingCase={{ ...row, plan_types: row.plan_types ? { name: row.plan_types.name } : null }}
      profileByRole={new Map(row.couple_profiles.map((p) => [p.partner_role, p]))}
      total={row.case_tasks.length}
      done={row.case_tasks.length - incomplete.length}
    />
  );
}
const LoadError = () => (
  <div role="alert" className="banner-error">
    <span>挙式の情報を読み込めませんでした。時間をおいて開き直してください。</span>
  </div>
);
const Waiting = () => (
  <EmptyState message="担当プランナーが準備を進めています。案件の情報が届くまでお待ちください。" />
);
export default async function CoupleCasePage() {
  return D1CoupleCase();
}
function CaseView({
  weddingCase,
  profileByRole,
  total,
  done,
}: {
  weddingCase: CaseRow;
  profileByRole: Map<PartnerRole, ProfileRow>;
  total: number;
  done: number;
}) {
  return (
    <div className="flex flex-col gap-[14px]">
      <h1 className="section-head">挙式情報</h1>

      <section className="card">
        <h2 className="text-label font-bold text-text-primary">基本情報</h2>
        <dl className="mt-3 flex flex-col gap-[10px]">
          <div>
            <dt className="text-caption text-text-muted">案件番号</dt>
            <dd className="text-base text-text-primary">{weddingCase.case_code}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">挙式日</dt>
            <dd className="text-base text-text-primary">
              {formatDateJp(weddingCase.wedding_date)}
              {/* wedding_time は time 型（HH:MM:SS）。式場側 K02 と同じく挙式日に添えて示す */}
              {weddingCase.wedding_time && `　${weddingCase.wedding_time.slice(0, 5)}`}
            </dd>
          </div>
          {PARTNER_ROLES.map((role) => (
            <div key={role}>
              <dt className="text-caption text-text-muted">{PARTNER_ROLE_LABEL[role]}</dt>
              {/* 氏名は暗号化列（5-3／13-1）。読めない値で画面を落とさないよう readPii() で畳む */}
              <dd className="text-base text-text-primary">
                {readPii(profileByRole.get(role)?.full_name) || '（未登録）'}
              </dd>
            </div>
          ))}
          <div>
            <dt className="text-caption text-text-muted">人数</dt>
            <dd className="text-base text-text-primary">
              {weddingCase.guest_count == null ? '未定' : `${weddingCase.guest_count}名`}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">プラン種別</dt>
            <dd className="text-base text-text-primary">
              {weddingCase.plan_types?.name ?? '未設定'}
            </dd>
          </div>
        </dl>
      </section>

      {/* 宿題進捗。M01 と同じく件数を淡々と示し、遅れを責める配色・文言にしない（4-3 M01） */}
      <section className="card flex items-center justify-between gap-3">
        <span className="text-label text-text-secondary">宿題の進みぐあい</span>
        <span className="text-title font-bold text-text-primary">
          {total === 0 ? '準備中' : `${done} / ${total} 件（${Math.round((done / total) * 100)}%）`}
        </span>
      </section>

      <p className="text-caption text-text-muted">
        内容の変更が必要なときは、担当プランナーへお知らせください。
      </p>

      <Link href="/mypage/guests" className="btn-secondary block text-center">
        ゲストの出欠を見る
      </Link>

      <Link href="/mypage/tasks" className="btn-secondary block text-center">
        宿題・提出物を見る
      </Link>
    </div>
  );
}
