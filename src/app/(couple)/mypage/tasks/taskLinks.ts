/**
 * M03 宿題詳細への行き来（docs/ui-review/p2/back-navigation.md）。
 *
 * M03 へはマイページ（次にやること）・宿題一覧・準備タイムライン（関連宿題を見る）から入る。
 * 「戻る」が宿題一覧に固定だと、ほかの画面から来た人が元の画面へ戻れないため、
 * 入口を ?from= で受け取り、「戻る」の行き先にする。
 *
 * from は決まったキーだけを受け付け、URL をそのまま戻り先に使わない
 * （任意のURLを渡せると、外のサイトへ誘導するリンクを作れてしまう）。
 * router.back() を使わないのは、URL を直接開いたときやリロード後に、
 * 履歴の前がアプリの外（メールやLINE）になることがあるため。
 */
const ORIGINS = {
  home: '/mypage',
  timeline: '/mypage/timeline',
} as const;

export type TaskOrigin = keyof typeof ORIGINS;

const TASK_LIST = '/mypage/tasks';

/** M03 へのリンク。宿題一覧から開くときは from を付けない（既定の戻り先）。 */
export function taskDetailHref(taskId: string, from?: TaskOrigin): string {
  return from ? `${TASK_LIST}/${taskId}?from=${from}` : `${TASK_LIST}/${taskId}`;
}

/** ?from= の値から「戻る」の行き先を決める。知らない値は宿題一覧へ寄せる。 */
export function taskBackHref(from: string | string[] | undefined): string {
  const key = typeof from === 'string' ? from : undefined;
  return key && Object.hasOwn(ORIGINS, key) ? ORIGINS[key as TaskOrigin] : TASK_LIST;
}

/** 提出後に戻る宿題一覧。提出した宿題の ID を渡し、一覧の上で「提出しました」を出す。 */
export function submittedListHref(taskId: string): string {
  return `${TASK_LIST}?submitted=${taskId}`;
}
