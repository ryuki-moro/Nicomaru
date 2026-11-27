/**
 * D01 運営ダッシュボード（system_admin）。
 *
 * system_admin の仕事は式場と職員の管理、システムの稼働確認なので、
 * 案件の中身や新郎新婦の個人情報は出さず、式場ごとの件数と「対応が必要なこと」だけを並べる。
 */
import type { AppUser } from '@/lib/auth/session';
import { venueOverviewD1, type VenueOverviewRow } from '@/lib/d1/admin';
import { listBatchRuns } from '@/lib/d1/batches';
import { listSystemAlerts } from '@/lib/d1/monitoring';
import { localDB } from '@/lib/d1/runtime';
import Link from 'next/link';
import { ChevronRight, SummaryCard } from './cards';

interface Todo {
  key: string;
  href: string;
  text: string;
}

/** 式場ごとの不足と、システム側の異常を「対応が必要なこと」にまとめる。 */
function todosFor(
  venues: VenueOverviewRow[],
  openAlertCount: number,
  failedJobCount: number,
): Todo[] {
  const todos: Todo[] = [];
  for (const v of venues.filter((venue) => venue.active)) {
    if (v.adminCount === 0)
      todos.push({
        key: `${v.id}-admin`,
        href: `/venues/${v.id}`,
        text: `${v.name}：利用中の式場管理者がいません`,
      });
    if (v.invitedCount > 0)
      todos.push({
        key: `${v.id}-invited`,
        href: `/venues/${v.id}`,
        text: `${v.name}：初回設定を待っている職員が${v.invitedCount}人います`,
      });
  }
  if (openAlertCount > 0)
    todos.push({
      key: 'alerts',
      href: '/system',
      text: `解消していないシステムの確認事項が${openAlertCount}件あります`,
    });
  if (failedJobCount > 0)
    todos.push({
      key: 'jobs',
      href: '/system',
      text: `直近で失敗した自動処理が${failedJobCount}種類あります`,
    });
  return todos;
}

export async function SystemDashboard({ user }: { user: AppUser }) {
  const db = await localDB();
  const [venues, alerts, runs] = await Promise.all([
    venueOverviewD1(db, user),
    listSystemAlerts(db, 50),
    listBatchRuns(db, undefined, 50),
  ]);
  // 処理ごとに最新の1回だけを見る。前回失敗していても、その後成功していれば対応不要
  const latestByJob = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!latestByJob.has(run.job_type)) latestByJob.set(run.job_type, run);
  const failedJobCount = [...latestByJob.values()].filter((run) => run.error_message).length;
  const openAlertCount = alerts.filter((alert) => !alert.resolved_at).length;
  const todos = todosFor(venues, openAlertCount, failedJobCount);

  const activeVenues = venues.filter((v) => v.active);
  const sum = (pick: (v: VenueOverviewRow) => number) =>
    activeVenues.reduce((total, v) => total + pick(v), 0);

  return (
    <div>
      <h1 className="section-head">ダッシュボード</h1>
      <p className="mt-1 text-caption text-text-muted">
        全式場の利用状況と、対応が必要なことを表示します。案件の内容や新郎新婦の個人情報は表示しません。
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard
          label="利用中の式場"
          value={activeVenues.length}
          unit="式場"
          href="/venues"
          linkLabel="式場管理を開く"
        />
        <SummaryCard
          label="利用中の職員"
          value={sum((v) => v.adminCount + v.plannerCount)}
          unit="人"
          href="/users"
          linkLabel="職員管理を開く"
        />
        <SummaryCard
          label="初回設定待ちの職員"
          value={sum((v) => v.invitedCount)}
          unit="人"
          note="案内メールの再送が必要な場合があります"
        />
        <SummaryCard label="進行中の案件" value={sum((v) => v.activeCaseCount)} unit="件" />
      </div>

      <section className="mt-5">
        <h2 className="section-head">対応が必要なこと</h2>
        {todos.length === 0 ? (
          <p className="card mt-2 text-label text-text-muted">対応が必要なことはありません。</p>
        ) : (
          <ul className="mt-2 overflow-hidden rounded-card border border-border-light bg-surface">
            {todos.map((todo) => (
              <li key={todo.key} className="border-b border-border-light last:border-b-0">
                <Link
                  href={todo.href}
                  prefetch={false}
                  className="flex items-center gap-3 px-4 py-3 text-label text-text-primary transition-colors hover:bg-field-filled-bg"
                >
                  <span className="min-w-0 flex-1">{todo.text}</span>
                  <ChevronRight />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-head">式場ごとの状況</h2>
          <Link href="/venues/new" prefetch={false} className="btn-ghost">
            式場を登録
          </Link>
        </div>
        {venues.length === 0 ? (
          <p className="card mt-2 text-label text-text-muted">
            登録されている式場はありません。「式場を登録」から追加してください。
          </p>
        ) : (
          <div className="table-wrap mt-2">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">式場</th>
                  <th scope="col">状態</th>
                  <th scope="col">式場管理者</th>
                  <th scope="col">プランナー</th>
                  <th scope="col">初回設定待ち</th>
                  <th scope="col">進行中の案件</th>
                </tr>
              </thead>
              <tbody>
                {venues.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link href={`/venues/${v.id}`} prefetch={false} className="table-link">
                        {v.name}
                      </Link>
                      <span className="ml-2 text-caption text-text-muted">{v.code}</span>
                    </td>
                    <td>{v.active ? '利用中' : '停止中'}</td>
                    <td>{v.adminCount === 0 ? '未登録' : `${v.adminCount}人`}</td>
                    <td>{v.plannerCount}人</td>
                    <td>{v.invitedCount}人</td>
                    <td>{v.activeCaseCount}件</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
