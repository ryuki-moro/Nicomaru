import type { Metadata } from 'next';

import { ErrorScreen, type ErrorMessage } from '@/components/layout/ErrorScreen';

export const metadata: Metadata = { title: 'ページを表示できません' };

/**
 * P04 エラーページ。
 *
 * 正本: 基本設計書 Version 1.2 4-3 P04「表示専用。ボタン『ログイン画面へ戻る』（P01）」。
 * 4-3 エラー表示規約により、権限エラー（403）・不存在（404）はこの画面へ遷移させる。
 * ログイン中はボタンを着地点へ戻すものに替える（ErrorScreen）。
 *
 * 表示する文言は任意の文字列をURLから受け取らず、コードごとの固定文言に限定する。
 * クエリの内容をそのまま出すと、偽の案内文を差し込んだURLを配れてしまうため。
 */
const MESSAGES: Record<string, ErrorMessage> = {
  '403': {
    heading: 'このページは表示できません',
    signedIn:
      'このアカウントでは開けないページです。' +
      '別のアカウントで開くときは、ログアウトしてからログインし直してください。',
    signedOut:
      'アクセスできる権限がないか、ログイン中のアカウントが変わっている可能性があります。' +
      'お手数ですが、ログインし直してからもう一度お試しください。',
  },
  '404': {
    heading: 'ページが見つかりません',
    signedIn: 'URLが変わったか、対象がすでに削除されている可能性があります。',
    signedOut:
      'URLが変わったか、対象がすでに削除されている可能性があります。' +
      'ログイン画面からお進みください。',
  },
};

const FALLBACK_DESCRIPTION =
  '一時的な問題が起きている可能性があります。' +
  'しばらく時間をおいてから、もう一度お試しください。';

const FALLBACK: ErrorMessage = {
  heading: 'ページを表示できませんでした',
  signedIn: FALLBACK_DESCRIPTION,
  signedOut: FALLBACK_DESCRIPTION,
};

export default async function ErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  return <ErrorScreen message={(code && MESSAGES[code]) || FALLBACK} />;
}
