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

/**
 * 4-3 エラー表示規約の共通処理。
 *
 *   「権限エラー（403）・不存在（404）は P04 エラーページへ遷移する。
 *     入力エラーは項目直下、それ以外はフォーム上部のサマリに出す」
 *
 * 12コンポーネント中4つにしか入っておらず、しかも判定基準が
 * 「error.status を見る」「result.code を見る」の2方式に割れていた。
 * その結果、同じ 404 でも画面によって P04 へ行ったり赤いサマリで終わったりしていた。
 *
 * 例: admin が K05 で案件をアーカイブした直後、K02 を開いたままのプランナーが
 * 「対応不要にする」を押すと 404 が返るが、サマリが出るだけで P04 へ行かない。
 *
 * 401（セッション切れ）は /login へ戻す。
 * middleware が /api を遮断しない（6-5-1 の 401 を返すため）ので、
 * 操作の途中でセッションが切れたことに気づけるのはこの経路だけになる。
 *
 * 遷移したときは true を返す。呼び出し側はそこで処理を打ち切る。
 */
export function handleApiError(
  error: unknown,
  router: { push: (href: string) => void },
  handlers: {
    /** 項目直下に出すエラー（400／422 の details） */
    onFieldErrors?: (fieldErrors: Record<string, string>) => void;
    /** フォーム上部のサマリに出す文言 */
    onSummary: (message: string) => void;
  },
): boolean {
  if (error instanceof ApiCallError) {
    // セッション切れ。middleware は /api を遮断しないので（6-5-1 の 401 を返すため）、
    // 操作の途中で切れたことに気づけるのはこの経路だけ。ログイン後は元の画面へ戻す（4-2）。
    if (error.status === 401) {
      const next = typeof window === 'undefined' ? '' : window.location.pathname;
      router.push(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
      return true;
    }
    if (error.status === 403 || error.status === 404) {
      router.push(`/error?code=${error.status}`);
      return true;
    }
    handlers.onSummary(error.message);
    handlers.onFieldErrors?.(error.fieldErrors);
    return false;
  }
  handlers.onSummary('通信に失敗しました。時間をおいてお試しください');
  handlers.onFieldErrors?.({});
  return false;
}
