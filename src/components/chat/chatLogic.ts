/**
 * チャット画面の純粋なロジック（接続の待ち時間・並べ方・スクロール判定）。
 * 画面部品から切り出し、単体テストで確かめられるようにしている。
 */
import { formatDateJp } from '@/lib/format';
import type { MessageView } from '@/lib/d1/messages';

export type { MessageView };

/** 再接続の待ち時間（秒）。最後の値で頭打ち */
export const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30] as const;
/** 連続でこの回数つなげなかったら、定期取得に切り替える */
export const MAX_CONNECT_FAILURES = 5;
export const FALLBACK_POLL_MS = 30_000;
export const PING_INTERVAL_MS = 25_000;
export const PAGE_SIZE = 50;
/** 下端からこの距離以内なら「読み終わっている」とみなす */
export const NEAR_BOTTOM_PX = 80;

/** 失敗 attempt 回目（0 始まり）の待ち時間。±20% のゆらぎを付けて同時再接続を散らす。 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_SECONDS[Math.min(Math.max(attempt, 0), BACKOFF_SECONDS.length - 1)] * 1000;
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** cursor は "ISO日時_id" で、日時が固定幅なので文字列の大小がそのまま時系列になる。 */
export function latestCursor(messages: readonly MessageView[]): string | undefined {
  let latest: string | undefined;
  for (const m of messages) if (latest === undefined || m.cursor > latest) latest = m.cursor;
  return latest;
}

/** id が同じものは新しい側で置き換え（取り消しの反映）、時系列に並べ直す。 */
export function mergeMessages(
  current: readonly MessageView[],
  incoming: readonly MessageView[],
): MessageView[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) =>
    a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0,
  );
}

/** 通知の cursor を持つメッセージがすでに手元にあるか（自分の投稿の通知で再取得しないため）。 */
export function knowsCursor(messages: readonly MessageView[], cursor: string): boolean {
  return messages.some((m) => m.cursor === cursor);
}

export function shouldAutoScroll(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = NEAR_BOTTOM_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/** 相手の最新の発言が、まだ既読として送っていないものか。 */
export function shouldMarkRead(
  messages: readonly MessageView[],
  lastMarked: string | undefined,
): boolean {
  let newestOther: string | undefined;
  for (const m of messages) {
    if (!m.mine && !m.retracted && (newestOther === undefined || m.cursor > newestOther))
      newestOther = m.cursor;
  }
  return newestOther !== undefined && (lastMarked === undefined || newestOther > lastMarked);
}

const JST = 'Asia/Tokyo';

/** 日本時間の日付キー（YYYY-MM-DD）。日付の区切り線に使う。 */
export function dayKeyJst(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: JST }).format(new Date(iso));
}

export function formatDayLabel(iso: string): string {
  return formatDateJp(dayKeyJst(iso));
}

export function formatTimeJst(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: JST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function canRetract(m: MessageView, retractWindowMs: number, now = Date.now()): boolean {
  return m.mine && !m.retracted && now - new Date(m.createdAt).getTime() < retractWindowMs;
}
