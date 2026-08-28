/**
 * UUID の形式判定。
 *
 * 経路パラメータをそのまま DB へ渡すと、UUID でない文字列は 22P02（invalid input syntax）で
 * 500 になる。「不正な形式は 404 として扱い、存在有無を漏らさない」（6-5-1）ため、
 * 各ハンドラの入口で弾く。
 *
 * 同じ正規表現が5ファイルに2つの名前（UUID_PATTERN／UUID_RE）で写経されていたので
 * ここへ寄せた。判定を直すときに片方だけ直す事故を防ぐ。
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
