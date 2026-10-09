/**
 * Route Handler の共通処理。
 *
 * 正本: 基本設計書 Version 1.2 6-5-1「エラーレスポンス共通仕様」。
 * 型・必須チェックは API 層、業務ルールはサービス層という分担を守る。
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { ApiError, badRequest } from '@/lib/errors';
import { toErrorDetails } from '@/lib/validation';

import { requireInternalCall } from './internal';
import { requireSameOrigin } from './origin';

interface RouteOptions {
  /** 内部cronだけはOriginの代わりに共有secretで認証する。検証の無効化ではない。 */
  source?: 'browser' | 'internal-cron';
}

/** リクエストボディを zod で検証する。失敗時は 400 VALIDATION_ERROR。 */
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest([{ field: '_', reason: 'リクエストの形式が正しくありません' }]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(toErrorDetails(parsed.error));
  }
  return parsed.data;
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data as object, { status });
}

export const noContent = () => new NextResponse(null, { status: 204 });

/**
 * 更新APIは本文や業務処理に触れる前に同一Originを検証する（基本設計9章 CSRF）。
 * 内部cronは明示指定した場合だけ共有secret認証へ切り替える。
 * ApiError と想定外例外は 6-5-1 の形式へ変換する。
 */
export function route<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
  options: RouteOptions = {},
) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    try {
      if (options.source === 'internal-cron') {
        requireInternalCall(request);
      } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        requireSameOrigin(request);
      }
      return await handler(request, ...args);
    } catch (error) {
      if (error instanceof ApiError) return error.toResponse();
      console.error('[api] unhandled error', error);
      return new ApiError('INTERNAL_ERROR').toResponse();
    }
  };
}
