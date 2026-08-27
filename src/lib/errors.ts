/**
 * API のエラーレスポンス共通仕様。
 * 正本: 基本設計書 Version 1.2 6-5-1「エラーレスポンス共通仕様」表6-7。
 * Route Handler を包むラッパーは src/lib/api/route.ts の route() に一本化してある
 * （ここに同じものを置くと 6-5-1 の形式を変えるときに片方だけ直る）。
 *
 *   { "error": { "code": "VALIDATION_ERROR", "message": "...",
 *                "details": [ { "field": "wedding_date", "reason": "..." } ] } }
 *
 * details[].field は画面側で該当項目の直下に表示するために使う（4-3 エラー表示規約）。
 */
import { NextResponse } from 'next/server';

export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * security definer 関数が業務ルール違反を通知するための独自 SQLSTATE。
 *
 * SQLSTATE は [0-9A-Z] の5文字で、標準が使わない範囲は実装が自由に使える。
 * 標準コードを転用すると（例: 外部キー違反の 23503 を 422 の代用にする）、
 * 本物の制約違反と区別できなくなり、利用者にも実態と違う文言が出る。
 * SQL 側は raise exception '文言' using errcode = 'BH422' のように使う。
 */
export const BUSINESS_RULE_SQLSTATE = 'BH422';
/** 状態競合（他の操作が先に走った）を通知する独自 SQLSTATE。 */
export const BUSINESS_RULE_CONFLICT_SQLSTATE = 'BH409';

export interface ErrorDetail {
  field: string;
  reason: string;
}

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: '入力内容に誤りがあります',
  UNAUTHENTICATED: 'ログインが必要です',
  FORBIDDEN: 'この操作を行う権限がありません',
  NOT_FOUND: '対象が見つかりません',
  CONFLICT: '他の操作と競合しました。画面を更新してからやり直してください',
  UNPROCESSABLE: 'この内容では処理できません',
  RATE_LIMITED: '試行回数の上限に達しました。しばらく時間をおいてからお試しください',
  INTERNAL_ERROR: 'サーバー側で問題が発生しました',
};

/** API 層で throw し、ルートハンドラの共通ラッパーがレスポンスへ変換する。 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = 'ApiError';
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }

  toResponse(): NextResponse {
    return NextResponse.json(
      { error: { code: this.code, message: this.message, details: this.details ?? [] } },
      { status: this.status },
    );
  }
}

export const badRequest = (details?: ErrorDetail[], message?: string) =>
  new ApiError('VALIDATION_ERROR', message, details);
export const unauthenticated = (message?: string) => new ApiError('UNAUTHENTICATED', message);
export const forbidden = (message?: string) => new ApiError('FORBIDDEN', message);
export const notFound = (message?: string) => new ApiError('NOT_FOUND', message);
export const conflict = (message?: string) => new ApiError('CONFLICT', message);
export const unprocessable = (message?: string, details?: ErrorDetail[]) =>
  new ApiError('UNPROCESSABLE', message, details);
export const rateLimited = (message?: string) => new ApiError('RATE_LIMITED', message);

/**
 * PostgreSQL / PostgREST のエラーを 6-5-1 のコードへ写像する。
 * RLS 拒否（42501）は 403、一意制約違反（23505）は 409 とする。
 */
export function fromPostgresError(error: { code?: string; message?: string } | null): ApiError {
  switch (error?.code) {
    case '42501':
      return forbidden();
    case '23505':
      return conflict();
    case '23503':
      return unprocessable('参照先のデータが存在しません');
    case '23514':
      return badRequest();
    case 'PGRST116':
      return notFound();
    // security definer 関数が業務ルール違反を通知するための独自 SQLSTATE。
    // 標準の SQLSTATE を転用すると（例: 外部キー違反の 23503）
    // 利用者に「参照先のデータが存在しません」のような実態と違う文言が出る。
    // 文言は関数側の raise message をそのまま使う（PostgREST が message を返す）。
    case BUSINESS_RULE_SQLSTATE:
      return unprocessable(error?.message || undefined);
    case BUSINESS_RULE_CONFLICT_SQLSTATE:
      return conflict(error?.message || undefined);
    default:
      return new ApiError('INTERNAL_ERROR');
  }
}
