/**
 * クライアント側から API を呼ぶための薄いラッパー。
 *
 * 6-5-1 のエラー形式を型で受け取り、画面が details[].field を項目直下へ
 * マッピングできるようにする（4-3 エラー表示規約）。
 */
'use client';

import type { ErrorCode, ErrorDetail } from '@/lib/errors';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details: ErrorDetail[];
}

export class ApiCallError extends Error {
  constructor(readonly body: ApiErrorBody, readonly status: number) {
    super(body.message);
    this.name = 'ApiCallError';
  }

  /** 項目名 → 最初のエラー文言。フォームの項目直下に出す用。 */
  get fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const d of this.body.details ?? []) {
      map[d.field] ??= d.reason;
    }
    return map;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = (json as { error?: ApiErrorBody }).error ?? {
      code: 'INTERNAL_ERROR' as ErrorCode,
      message: '通信に失敗しました。時間をおいてお試しください',
      details: [],
    };
    throw new ApiCallError(error, response.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};
