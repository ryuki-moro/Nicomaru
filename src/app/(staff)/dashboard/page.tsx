/**
 * D01 プランナーダッシュボード（4-1／4-3 D01）。
 *
 * サマリーカードは「担当案件数」「未提出件数」「リスク高件数」（機能4-1／6-2、Phase 2）に、
 * 「確認待ちの提出物」を加えた4枚。毎朝最初に開く画面なので、カードは低く横一列に並べ、
 * PC（1440×900）の最初の表示に「今日フォローすべきカップル」の先頭が入るようにする。
 * 「確認待ちの提出物」は件数からそのまま提出物確認（D02）へ移動できる。
 * 「今日フォローすべきカップル」は機能4-2。リスクの高い順に並べ、
 * スコアだけでなく**根拠を必ず併記**する（4-3 D01）。
 * 根拠なしの数値だけを出さないのは、1-4「最終判断はプランナーが行う。
 * システムは判断を代替しない」と 8-5 の説明可能性に対応するため。
 *
 * 値は risk_score_snapshots の現在値を読むだけで、ここでは再計算しない
 * （6-8「一覧表示時に毎回全件再計算せず、更新時・定期処理・明示再計算で保存する」）。
 *
 * 読み取りは 6-5 の原則どおり Server Component から RLS 適用クライアントで直接 select する。
 */
import Link from 'next/link';

import { RiskBadge } from '@/components/ui/RiskBadge';
import { requireStaff } from '@/lib/auth/session';
import { dashboard } from '@/lib/d1/dashboard';
import { localDB } from '@/lib/d1/runtime';
import { formatDate } from '@/lib/format';

interface CaseIdRow {
  id: string;
}

export default async function PlannerDashboardPage() {
  const user = await requireStaff();
  const {
    caseCount,
    unsubmittedCount,
    pendingReviewCount,
    highRiskCount,
    followUps: allFollowUps,
  } = await dashboard(await localDB(), user);
  const followUps = allFollowUps.slice(0, 10);

  const caseCountLabel = user.role === 'planner' ? '担当案件数' : '式場の案件数';

  return (
    <div>
      <h1 className="section-head">ダッシュボード</h1>
      <p className="mt-1 text-caption text-text-muted">{user.displayName} さんの担当状況です。</p>

      {/* 4枚を 2列（スマートフォン）／4列（PC）で並べ、1枚だけ次の段に残らないようにする */}
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label={caseCountLabel} value={caseCount} unit="件" />
        <SummaryCard
          label="未提出の宿題"
          value={unsubmittedCount}
          unit="件"
          note="未着手・不備ありの合計です"
        />
        <SummaryCard
          label="確認待ちの提出物"
          value={pendingReviewCount}
          unit="件"
          href="/submissions"
          linkLabel="提出物確認を開く"
        />
        <SummaryCard
          label="リスクが高い案件"
          value={highRiskCount}
          unit="件"
          note="直近の算出結果です"
        />
      </div>

      <section className="mt-5">
        <h2 className="section-head">今日フォローすべきカップル</h2>
        <p className="mt-1 text-caption text-text-muted">
          リスクの高い順に表示しています。判断の材料としてお使いください。
        </p>
        {followUps.length === 0 ? (
          <p className="card mt-2 text-label text-text-muted">いま気にかけたい案件はありません。</p>
        ) : (
          // 1件を1行にまとめて上から走査できるようにする。行全体が案件詳細へのリンクで、
          // 左にリスク、中央に名前と根拠、右に「開ける」ことを示す矢印を置く。
          <ul className="mt-2 overflow-hidden rounded-card border border-border-light bg-surface">
            {followUps.map((item) => (
              <li key={item.caseId} className="border-b border-border-light last:border-b-0">
                <Link
                  href={`/cases/${item.caseId}`}
                  prefetch={false}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-field-filled-bg"
                >
                  <span className="w-16 shrink-0 pt-[2px]">
                    <RiskBadge level={item.scoreLevel} reasons={item.reasons} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-3">
                      <span className="text-base font-bold text-text-primary">
                        {item.coupleName || item.caseCode}
                      </span>
                      <span className="text-caption text-text-muted">
                        {item.caseCode}
                        {item.weddingDate ? ` ／ 挙式 ${formatDate(item.weddingDate)}` : ''}
                      </span>
                    </span>
                    {/* 4-3 D01「スコア根拠を併記」。根拠のない数値だけは出さない */}
                    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {item.reasons.map((reason) => (
                        <li key={reason.conditionKey} className="text-label text-text-secondary">
                          ・{reason.description ?? reason.name}
                        </li>
                      ))}
                    </ul>
                  </span>
                  <ChevronRight />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h2 className="section-head">よく使う画面</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <NavCard
            href="/cases"
            title="案件一覧"
            description="担当している案件の進捗を確認します"
          />
          <NavCard
            href="/submissions"
            title="提出物確認"
            description="新郎新婦から届いた提出物を確認します"
          />
          <NavCard
            href="/notifications"
            title="通知履歴"
            description="送信した通知と送信結果を確認します"
          />
          {/* S01〜S03 は system_admin 専用（4-3）。他のロールには導線を出さない */}
          {user.role === 'system_admin' && (
            <>
              <NavCard
                href="/venues"
                title="式場管理"
                description="式場と式場管理者を登録・確認します"
              />
              <NavCard
                href="/system"
                title="利用状況・通知ログ"
                description="定期処理の実行結果と通知ログを確認します"
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  unit,
  note,
  href,
  linkLabel,
}: {
  label: string;
  value: number;
  unit: string;
  note?: string;
  /** 件数から移動できる先。指定するとカード全体がリンクになる */
  href?: string;
  /** リンクであることを文字でも示す（色や枠だけに頼らない） */
  linkLabel?: string;
}) {
  const body = (
    <>
      <p className="text-caption text-text-muted">{label}</p>
      <p className="mt-[2px]">
        <span className="text-[28px] font-bold leading-9 text-text-primary">{value}</span>
        <span className="ml-1 text-label text-text-secondary">{unit}</span>
      </p>
      {note && <p className="text-caption text-text-muted">{note}</p>}
      {href && linkLabel && (
        <p className="flex items-center gap-1 text-caption font-bold text-link">
          {linkLabel}
          <ChevronRight small />
        </p>
      )}
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        prefetch={false}
        className="card block py-3 transition-colors hover:bg-field-filled-bg"
      >
        {body}
      </Link>
    );
  }
  return <div className="card py-3">{body}</div>;
}

/** Tabler Icons の chevron-right（design_guide 6 のアイコンセット）。 */
function ChevronRight({ small = false }: { small?: boolean }) {
  const size = small ? 14 : 20;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={small ? 'shrink-0' : 'mt-[2px] shrink-0 text-text-muted'}
    >
      <path d="M9 6l6 6l-6 6" />
    </svg>
  );
}

function NavCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="card block transition-colors hover:bg-field-filled-bg"
    >
      <p className="text-section font-bold text-text-primary">{title}</p>
      <p className="mt-1 text-caption text-text-muted">{description}</p>
    </Link>
  );
}
