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
import { ChevronRight, NavCard, SummaryCard } from './cards';
import { AdminSetupChecklist } from './AdminSetupChecklist';
import { SystemDashboard } from './SystemDashboard';

interface CaseIdRow {
  id: string;
}

export default async function PlannerDashboardPage() {
  const user = await requireStaff();
  // system_admin は案件を担当しないので、式場と職員の運営状況を出す
  if (user.role === 'system_admin') return <SystemDashboard user={user} />;
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
          label="未提出のやること"
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
          label="遅れそうな案件"
          value={highRiskCount}
          unit="件"
          note="直近の算出結果です"
        />
      </div>

      {user.role === 'admin' && <AdminSetupChecklist user={user} />}

      <section className="mt-5">
        <h2 className="section-head">今日フォローすべきカップル</h2>
        <p className="mt-1 text-caption text-text-muted">
          遅れそうな順に表示しています。判断の材料としてお使いください。
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
        </div>
      </section>
    </div>
  );
}
