/**
 * API のエラーレスポンス共通仕様。
 * 正本: 基本設計書 Version 1.2 6-5-1「エラーレスポンス共通仕様」表6-7。
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
    default:
      return new ApiError('INTERNAL_ERROR');
  }
}

/** ルートハンドラを包み、ApiError と想定外例外をレスポンスへ変換する。 */
export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error.toResponse();
    }
    // 想定外の例外は内容をクライアントへ返さない（9章）。サーバーログにのみ残す。
    console.error('[api] unhandled error', error);
    return new ApiError('INTERNAL_ERROR').toResponse();
  }
}
