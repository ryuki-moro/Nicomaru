/**
 * 案件一覧とアーカイブのサービス層（機能2-1〜2-6）。
 *
 * 正本: 基本設計書 4-3 K01／K05、5-1「削除方針」、6-2、6-8。
 *
 * K01 の一覧が画面（Server Component）と API（GET /api/cases）に二重実装され、
 * すでに挙動が食い違っていた。画面だけがキーワード検索・リスク順・現在リスクの表示を持ち、
 * API 側は q を無視して別の列を返していた。
 * 表6-6 が GET /api/cases を必須APIとして定義しているため API は消せないので、
 * 両方がここを呼ぶ形に寄せる。
 */
import type { RiskReasonView } from '@/components/ui/RiskBadge';
import {
  COUPLE_PROFILE_COLUMNS,
  INCOMPLETE_TASK_STATUSES,
  RISK_LEVEL_RANK,
  type CaseStatus,
  type PartnerRole,
  type RiskLevel,
  type TaskStatus,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { fromPostgresError } from '@/lib/errors';
import type { SupabaseServerClient } from '@/lib/supabase/server';

/**
 * 氏名は暗号化列のため、DB側では部分一致検索ができない（13-1）。
 * キーワード検索は復号後にサーバー上で一致判定するので、
 * 走査対象を想定規模（8-3 登録案件数300件）に余裕をみた上限で打ち切る。
 */
export const SEARCH_SCAN_LIMIT = 500;

/**
 * couple_profiles は memo を列レベル権限で剥奪しているため select * が 42501 になる（付録A）。
 * リスクは現在値だけを使うが、埋め込みは配列で返るので is_current で絞る（6-8）。
 */
const CASE_LIST_SELECT =
  `id, case_code, wedding_date, status,
   plan_types ( name ),
   couple_profiles ( ${COUPLE_PROFILE_COLUMNS} ),
   case_tasks ( status ),
   risk_score_snapshots ( score_value, score_level, reasons, is_current )`;

interface CaseListRow {
  id: string;
  case_code: string;
  wedding_date: string;
  status: CaseStatus;
  plan_types: { name: string } | null;
  couple_profiles: { partner_role: PartnerRole; full_name: string }[];
  case_tasks: { status: TaskStatus }[];
  risk_score_snapshots: {
    score_value: number;
    score_level: RiskLevel;
    reasons: RiskReasonView[] | null;
    is_current: boolean;
  }[];
}

/** 一覧1行の表示用データ。氏名は復号済み。 */
export interface CaseListItem {
  id: string;
  caseCode: string;
  weddingDate: string;
  status: CaseStatus;
  planTypeName: string;
  /** 新郎新婦の氏名を「・」で連結したもの（復号済み） */
  coupleName: string;
  partners: { partnerRole: PartnerRole; fullName: string }[];
  total: number;
  done: number;
  risk: { score_value: number; score_level: RiskLevel; reasons: RiskReasonView[] | null } | null;
}

export type CaseListScope = 'active' | 'archived';
export type CaseListSort = 'wedding_date' | 'risk';

export interface CaseListResult {
  items: CaseListItem[];
  /** 次のページがあるか。キーワード検索時は絞り込み後の件数で判定する */
  hasNext: boolean;
  /** 走査上限に当たったか。当たっていれば画面に「絞り込んでください」と出す */
  truncated: boolean;
}

/**
 * K01 一覧を引く。
 *
 * 範囲は RLS（accessible_case_ids）が担保する。ここでの絞り込みは表示上の都合であって
 * 権限の境界ではない。アーカイブ済みの参照可否も RLS が最終防衛線。
 *
 * キーワードがあるときは DB 側でページングできない。
 * 氏名が暗号化されていて DB では一致判定できず、リスク順も現在値が埋め込みの配列にあるため
 * DB 側で order できないため。どちらもサーバー上で処理してから切り出す。
 */
export async function loadCaseList(
  supabase: SupabaseServerClient,
  options: {
    scope: CaseListScope;
    sort?: CaseListSort;
    keyword?: string | null;
    offset?: number;
    limit: number;
  },
): Promise<CaseListResult> {
  const keyword = (options.keyword ?? '').trim();
  const sort: CaseListSort = options.sort === 'risk' ? 'risk' : 'wedding_date';
  const offset = Math.max(options.offset ?? 0, 0);

  let query = supabase
    .from('wedding_cases')
    .select(CASE_LIST_SELECT)
    // 並びは挙式日順、同着は id を最終タイブレークに用いる（4-3 一覧画面共通）
    .order('wedding_date', { ascending: true })
    .order('id', { ascending: true });

  query = options.scope === 'archived'
    ? query.eq('status', 'archived')
    : query.neq('status', 'archived');

  // リスク順も現在値の抽出をサーバー上で行うため、DB 側のページングが使えない
  const serverSide = keyword !== '' || sort === 'risk';
  query = serverSide
    ? query.limit(SEARCH_SCAN_LIMIT)
    : query.range(offset, offset + options.limit - 1);

  const { data, error } = await query;
  if (error) throw fromPostgresError(error);

  const rows = (data ?? []) as unknown as CaseListRow[];
  const decorated: CaseListItem[] = rows.map((row) => {
    const total = row.case_tasks.length;
    const incomplete = row.case_tasks.filter((t) => INCOMPLETE_TASK_STATUSES.includes(t.status)).length;
    // 氏名は暗号化列（13-1）。鍵が合わない値1件で一覧全体を 500 にしないよう readPii を使う
    const partners = row.couple_profiles.map((profile) => ({
      partnerRole: profile.partner_role,
      fullName: readPii(profile.full_name),
    }));
    const current = row.risk_score_snapshots?.find((r) => r.is_current) ?? null;
    return {
      id: row.id,
      caseCode: row.case_code,
      weddingDate: row.wedding_date,
      status: row.status,
      planTypeName: row.plan_types?.name ?? '未設定',
      coupleName: partners.map((p) => p.fullName).filter((n) => n.length > 0).join('・'),
      partners,
      total,
      done: total - incomplete,
      // 現在値だけを採る。無ければ「未算出」と出す（空欄にすると「低い」と読まれる）
      risk: current
        ? { score_value: current.score_value, score_level: current.score_level, reasons: current.reasons }
        : null,
    };
  });

  // 4-3 K01: リスクが高い順。未算出は末尾へ送る。
  const sorted = sort === 'risk'
    ? [...decorated].sort((a, b) =>
        (b.risk ? RISK_LEVEL_RANK[b.risk.score_level] : -1)
          - (a.risk ? RISK_LEVEL_RANK[a.risk.score_level] : -1)
        || (b.risk?.score_value ?? -1) - (a.risk?.score_value ?? -1)
        || a.weddingDate.localeCompare(b.weddingDate)
        || a.id.localeCompare(b.id))
    : decorated;

  const filtered = keyword === ''
    ? sorted
    : sorted.filter((row) => row.caseCode.includes(keyword) || row.coupleName.includes(keyword));

  const items = serverSide ? filtered.slice(offset, offset + options.limit) : filtered;
  const hasNext = serverSide
    ? filtered.length > offset + options.limit
    : items.length === options.limit;

  return { items, hasNext, truncated: serverSide && rows.length >= SEARCH_SCAN_LIMIT };
}

/**
 * 案件のアーカイブ／復元（機能2-5・2-6）。
 *
 * apply_case_update() は6引数で、PostgREST は引数が足りない RPC を
 * 「関数が見つからない」として扱う。呼び出しが3箇所に写経されていたため、
 * 引数を1つ足すと直し忘れた経路だけが静かに壊れる状態だった。
 * 権限（admin のみ）は関数側でも検証される。
 */
export async function setCaseArchived(
  supabase: SupabaseServerClient,
  caseId: string,
  archived: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('apply_case_update', {
    p_case_id: caseId,
    p_patch: { archived },
    p_profiles: {},
    p_due_changes: [],
    p_waived_task_ids: null,
    p_new_tasks: [],
  });
  if (error) throw fromPostgresError(error);
}
