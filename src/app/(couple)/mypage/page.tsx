/**
 * M01 マイページダッシュボード（couple）。
 *
 * 正本: 基本設計書 Version 1.2 4-3「M01 マイページダッシュボード」。
 *   表示項目は「挙式日までの残日数」「次にやること（最大3件）」「未提出宿題件数」の3つに限る。
 *   リスクスコアなど『責められている』と感じさせる表現は使用しない（4-3 M01）ため、
 *   risk_score_snapshots は参照せず、遅延・超過を強調する配色も使わない。
 *
 * 読み取りのみの画面なので Route Handler を介さず Supabase クライアントから直接 select する
 * （6-5「本表に現れない画面操作は Supabase クライアント経由の直接アクセス（RLS適用）」）。
 * どの案件が見えるかは付録A の accessible_case_ids() が決めるため、
 * 本画面では case_id の絞り込みを自前で書かず RLS に委ねる。
 */
import Link from 'next/link';

import { EmptyState } from '@/components/ui/EmptyState';
import {
  COUPLE_PROFILE_COLUMNS,
  INCOMPLETE_TASK_STATUSES,
  PARTNER_ROLES,
  UNSUBMITTED_TASK_STATUSES,
  type PartnerRole,
  type TaskStatus,
} from '@/lib/constants';
import { decryptPii } from '@/lib/crypto';
import { daysUntilWedding, nextActions, type IsoDate } from '@/lib/services/schedule';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'マイページ' };

interface TaskRow {
  id: string;
  title: string;
  due_date: IsoDate;
  status: TaskStatus;
  display_order: number;
}

interface ProfileRow {
  partner_role: PartnerRole;
  full_name: string | null;
}

/**
 * 期限・挙式日は date 型（時刻を持たない）なので、比較の基準日も日本時間の暦日で取る。
 * UTC の today を使うと日本時間の朝9時までズレた残日数になる。
 */
function todayInJst(): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

/** 'YYYY-MM-DD' → '2026年8月28日'。Date を経由しないのでタイムゾーンの影響を受けない。 */
function formatJpDate(iso: IsoDate): string {
  const [year, month, day] = iso.split('-');
  return `${Number(year)}年${Number(month)}月${Number(day)}日`;
}

/**
 * couple_profiles.full_name はアプリ側 AES-256-GCM の暗号化対象（5-3／13-1）。
 * 開発用シードなど平文のまま入っている値も表示できるよう、接頭辞で判別する。
 */
function decodeName(stored: string | null): string | null {
  if (!stored) return null;
  try {
    return stored.startsWith('v1:') ? decryptPii(stored) : stored;
  } catch {
    // 鍵未設定・改ざんで復号できない場合でもカウントダウンは表示したいので名前だけ落とす
    return null;
  }
}

export default async function MyPage() {
  const supabase = await createSupabaseServerClient();

  // RLS により couple には自分の案件しか見えない。複数ある場合は挙式日が近いものを主とする。
  const { data: weddingCase, error } = await supabase
    .from('wedding_cases')
    .select('id, wedding_date')
    .order('wedding_date', { ascending: true })
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

  const caseId = weddingCase.id as string;
  const weddingDate = weddingCase.wedding_date as IsoDate;

  const [profileResult, taskResult, unsubmittedResult] = await Promise.all([
    supabase.from('couple_profiles').select(COUPLE_PROFILE_COLUMNS).eq('case_id', caseId),
    supabase
      .from('case_tasks')
      .select('id, title, due_date, status, display_order')
      .eq('case_id', caseId)
      .in('status', [...INCOMPLETE_TASK_STATUSES])
      // 並びの正本は 4-3／6-6-2 の ORDER BY due_date, display_order, id
      .order('due_date', { ascending: true })
      .order('display_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('case_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('case_id', caseId)
      .in('status', [...UNSUBMITTED_TASK_STATUSES]),
  ]);

  // COUPLE_PROFILE_COLUMNS は連結で組み立てた string のため supabase-js の
  // 型レベル select パーサが解決できない。行の形は上の ProfileRow が正本。
  const profiles = (profileResult.data ?? []) as unknown as ProfileRow[];
  const names = [...profiles]
    .sort((a, b) => PARTNER_ROLES.indexOf(a.partner_role) - PARTNER_ROLES.indexOf(b.partner_role))
    .map((p) => decodeName(p.full_name))
    .filter((name): name is string => name !== null);

  const tasks = (taskResult.data ?? []) as TaskRow[];
  // 「最大3件」の切り出しはサービス層の nextActions() に寄せる（11章の単体テスト対象）
  const actions = nextActions(
    tasks.map((t) => ({ ...t, dueDate: t.due_date, displayOrder: t.display_order })),
  );
  const unsubmitted = unsubmittedResult.count ?? 0;

  const today = todayInJst();
  const remaining = daysUntilWedding(weddingDate, today);

  return (
    <div className="flex flex-col gap-[14px]">
      {/* 挙式カウントダウン（design_guide 5.8） */}
      <section className="card-hero" aria-label="挙式までの残り日数">
        <p className="text-label text-primary-dark/70">
          {names.length > 0 && <>{names.join('・')}　</>}
          {formatJpDate(weddingDate)}
        </p>
        {remaining > 0 ? (
          <p className="mt-1 flex items-baseline gap-1 text-primary-darker">
            <span className="text-label">挙式まであと</span>
            <span className="text-hero font-bold">{remaining}</span>
            <span className="text-base font-bold">日</span>
          </p>
        ) : remaining === 0 ? (
          <p className="mt-1 text-title font-bold text-primary-darker">いよいよ挙式当日です</p>
        ) : (
          <p className="mt-1 text-title font-bold text-primary-darker">
            ご結婚おめでとうございます
          </p>
        )}
      </section>

      {/* 次にやること（最大3件） */}
      <section>
        <h2 className="section-head mb-2">次にやること</h2>
        {actions.length === 0 ? (
          <EmptyState message="いまお願いしている宿題はありません。ゆっくり準備を進めましょう。" />
        ) : (
          <ul className="flex flex-col gap-[10px]">
            {actions.map((task) => (
              <li key={task.id}>
                <Link
                  href={`/mypage/tasks/${task.id}`}
                  className="flex items-center gap-3 rounded-card bg-field-filled-bg px-4 py-[13px]"
                >
                  <span className="flex-1">
                    <span className="block text-label text-text-muted">
                      {formatJpDate(task.due_date)}まで
                    </span>
                    <span className="block text-base text-text-primary">{task.title}</span>
                  </span>
                  <ChevronRight />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 未提出件数。件数だけを淡々と示し、遅れを責める配色・文言にしない（4-3 M01） */}
      <section className="card flex items-center justify-between">
        <span className="text-label text-text-secondary">これから提出する宿題</span>
        <span className="text-title font-bold text-text-primary">{unsubmitted}件</span>
      </section>

      <div className="mt-1 flex flex-col gap-[10px]">
        <Link href="/mypage/tasks" className="btn-primary block text-center">
          宿題・提出物を見る
        </Link>
        <Link href="/mypage/timeline" className="btn-secondary block text-center">
          準備タイムラインを見る
        </Link>
      </div>
    </div>
  );
}

/** Tabler Icons の chevron-right（design_guide 6 のアイコンセット）。 */
function ChevronRight() {
  return (
    <svg
      aria-hidden
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted"
    >
      <path d="M9 6l6 6l-6 6" />
    </svg>
  );
}
