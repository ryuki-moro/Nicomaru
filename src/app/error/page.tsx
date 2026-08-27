import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'ページを表示できません' };

/**
 * P04 エラーページ。
 *
 * 正本: 基本設計書 Version 1.2 4-3 P04「表示専用。ボタン『ログイン画面へ戻る』（P01）」。
 * 4-3 エラー表示規約により、権限エラー（403）・不存在（404）はこの画面へ遷移させる。
 *
 * 表示する文言は任意の文字列をURLから受け取らず、コードごとの固定文言に限定する。
 * クエリの内容をそのまま出すと、偽の案内文を差し込んだURLを配れてしまうため。
 *
 * 同じ見た目を app/not-found.tsx でも使うが、
 * page.tsx から default 以外を export すると Next.js の型検証が落ちるため共有はしない。
 */
const MESSAGES: Record<string, { heading: string; description: string }> = {
  '403': {
    heading: 'このページは表示できません',
    description:
      'アクセスできる権限がないか、ログイン中のアカウントが変わっている可能性があります。'
      + 'お手数ですが、ログインし直してからもう一度お試しください。',
  },
  '404': {
    heading: 'ページが見つかりません',
    description:
      'URLが変わったか、対象がすでに削除されている可能性があります。'
      + 'ログイン画面からお進みください。',
  },
};

const FALLBACK = {
  heading: 'ページを表示できませんでした',
  description:
    '一時的な問題が起きている可能性があります。'
    + 'しばらく時間をおいてから、もう一度お試しください。',
};

export default async function ErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const message = (code && MESSAGES[code]) || FALLBACK;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg">
      <div className="screen flex flex-col gap-4">
        <div className="card flex flex-col gap-2 text-center">
          <h1 className="text-title font-bold text-text-primary">{message.heading}</h1>
          {/* 要件: 責められていると感じさせず、次の操作が分かる文言にする */}
          <p className="text-label text-text-secondary">{message.description}</p>
        </div>
        <Link href="/login" className="btn-primary text-center">
          ログイン画面へ戻る
        </Link>
      </div>
    </div>
  );
}
