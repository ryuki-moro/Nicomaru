/**
 * 日付・時刻の表示形式の単一ソース。
 *
 * 表6-9 が DB値とUI表示名を1箇所に集めているのと同じ理由で、日付表記もここに集約する。
 * 画面ごとに Intl.DateTimeFormat や replaceAll('-', '/') を書くと、
 * 同じ期限が D02 では「2026/08/28」、M02 では「2026年8月28日」のように割れる。
 *
 * 挙式日・期限は date 型（時刻を持たない）ので、暦日は必ず日本時間で解釈する。
 * サーバーが UTC で動く環境では、JST の 0:00〜9:00 に UTC 基準で計算すると前日になる。
 */
const JST = 'Asia/Tokyo';

/** 'YYYY-MM-DD' 形式で日本時間の今日を返す。過去日判定・残日数計算の基準に使う。 */
export function todayInJst(now: Date = new Date()): string {
  // en-CA は YYYY-MM-DD を返すロケール。手組みの getFullYear より取り違えが少ない。
  return new Intl.DateTimeFormat('en-CA', { timeZone: JST }).format(now);
}

/** 'YYYY-MM-DD' → 'YYYY/MM/DD'。式場側の一覧・詳細で使う。 */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  return isoDate.replaceAll('-', '/');
}

/** 'YYYY-MM-DD' → 'YYYY年M月D日'。新郎新婦向け画面で使う（やわらかい表記）。 */
export function formatDateJp(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) return isoDate;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

/** timestamptz → 'YYYY/MM/DD HH:mm'（日本時間）。記録日時・送信日時で使う。 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: JST,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}
