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

const COMMUNICATION_ERROR_MESSAGE = '通信に失敗しました。時間をおいてお試しください';
const ERROR_CODES = new Set<ErrorCode>([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeErrorBody(value: unknown): ApiErrorBody {
  const error = isRecord(value) ? value : {};
  return {
    code:
      typeof error.code === 'string' && ERROR_CODES.has(error.code as ErrorCode)
        ? (error.code as ErrorCode)
        : 'INTERNAL_ERROR',
    message:
      typeof error.message === 'string' && error.message.trim() !== ''
        ? error.message
        : COMMUNICATION_ERROR_MESSAGE,
    details: Array.isArray(error.details)
      ? error.details.filter(
          (detail): detail is ErrorDetail =>
            isRecord(detail) &&
            typeof detail.field === 'string' &&
            typeof detail.reason === 'string',
        )
      : [],
  };
}

export class ApiCallError extends Error {
  readonly body: ApiErrorBody;

  constructor(
    body: unknown,
    readonly status: number,
  ) {
    const normalizedBody = normalizeErrorBody(body);
    super(normalizedBody.message);
    this.body = normalizedBody;
    this.name = 'ApiCallError';
  }

  /** 項目名 → 最初のエラー文言。フォームの項目直下に出す用。 */
  get fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const d of this.body.details) {
      if (!Object.hasOwn(map, d.field)) {
        // __proto__ なども項目名として扱い、継承プロパティや setter に影響されないようにする。
        Object.defineProperty(map, d.field, {
          value: d.reason,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
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

  if (!response.ok) {
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // プロキシなどが HTML を返しても HTTP status を失わず、共通エラー処理へ渡す。
      json = undefined;
    }
    throw new ApiCallError(isRecord(json) ? json.error : undefined, response.status);
  }
  const json = text ? JSON.parse(text) : {};
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
  handlers.onSummary(COMMUNICATION_ERROR_MESSAGE);
  handlers.onFieldErrors?.({});
  return false;
}
