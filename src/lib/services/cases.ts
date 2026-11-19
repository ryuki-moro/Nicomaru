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
import { type CaseStatus, type PartnerRole, type RiskLevel } from '@/lib/constants';

/**
 * 氏名は暗号化列のため、DB側では部分一致検索ができない（13-1）。
 * キーワード検索は復号後にサーバー上で一致判定するので、
 * 走査対象を想定規模（8-3 登録案件数300件）に余裕をみた上限で打ち切る。
 */
export const SEARCH_SCAN_LIMIT = 500;

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
