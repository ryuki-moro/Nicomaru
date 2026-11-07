/**
 * 卓の配置パターン（#180）のテンプレートと、席次のルールで「座れる人」を振る関数。
 *
 * 席次プロトタイプ（docs/画面設計 の席次プロトタイプ HTML、TEMPLATES・applyRules）を移したもの。
 * 画面（ブラウザー）でも使うので、DB や node: のモジュールに依存しない。
 *
 * 卓の「座れる人」は、ゲストのタグのキー（src/lib/guest-tags.ts）の配列で持つ。
 *   - 空の配列: だれでも座れる
 *   - 同じ種類（side:・relationship: など、":" より前が同じもの）のキーは「または」
 *   - 種類が違えば「かつ」
 *   例: ['side:groom', 'relationship:colleague', 'relationship:teacher']
 *       = 新郎側で、かつ職場関係または恩師の人
 */
import type { GuestRelationship, PartnerRole } from '@/lib/constants';

export const HALL_SHAPES = ['wide', 'tall'] as const;
export type HallShape = (typeof HALL_SHAPES)[number];
export const HALL_SHAPE_LABEL: Record<HallShape, string> = { wide: '横型', tall: '縦型' };
export const HALL_SHAPE_NOTE: Record<HallShape, string> = {
  wide: '高砂が長い辺にある会場',
  tall: '高砂が短い辺にある会場',
};

export const TABLE_SHAPES = ['round', 'rect', 'rectv'] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];
export const TABLE_SHAPE_LABEL: Record<TableShape, string> = {
  round: '円卓',
  rect: '長テーブル（横向き）',
  rectv: '長テーブル（縦向き）',
};

/** DB の制約（seating_tables・save_seating_layout()）と揃える */
export const TABLE_CAPACITY_MIN = 2;
export const TABLE_CAPACITY_MAX = 20;
export const TABLES_PER_LAYOUT_MAX = 26;
export const LAYOUTS_PER_CASE_MAX = 20;
export const LAYOUT_NAME_MAX = 30;
export const TABLE_NAME_MAX = 20;
export const TABLE_TAGS_MAX = 30;

export interface SeatingTable {
  /** 保存済みの卓の ID。新しい卓は undefined */
  id?: string;
  name: string;
  capacity: number;
  shape: TableShape;
  /** 会場図の中の位置（左上 0、右下 1 の割合） */
  x: number;
  y: number;
  allowedTags: string[];
}

export interface LayoutTemplate {
  key: string;
  name: string;
  make: () => SeatingTable[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 列 × 段に卓を並べる。名前は「1卓」「2卓」…、座れる人は空（だれでも） */
export function gridTables(
  xs: number[],
  ys: number[],
  capacity: number,
  shape: TableShape = 'round',
): SeatingTable[] {
  return ys
    .flatMap((y) => xs.map((x) => ({ x, y })))
    .map((p, i) => ({
      name: `${i + 1}卓`,
      capacity,
      shape,
      x: round3(p.x),
      y: round3(p.y),
      allowedTags: [],
    }));
}

/** 「配置を作る」: 卓の形・列・段・定員を選んで、会場の中に等間隔で並べる */
export function buildGrid(
  hall: HallShape,
  shape: TableShape,
  cols: number,
  rows: number,
  capacity: number,
): SeatingTable[] {
  const tall = hall === 'tall';
  const xs =
    cols === 1 ? [0.5] : Array.from({ length: cols }, (_, i) => 0.12 + (0.76 * i) / (cols - 1));
  const y0 = tall ? 0.26 : 0.38;
  const y1 = tall ? 0.86 : 0.8;
  const ys =
    rows === 1
      ? [(y0 + y1) / 2]
      : Array.from({ length: rows }, (_, i) => y0 + ((y1 - y0) * i) / (rows - 1));
  return gridTables(xs, ys, capacity, shape);
}

export const LAYOUT_TEMPLATES: Record<HallShape, LayoutTemplate[]> = {
  wide: [
    {
      key: 'round8',
      name: '円卓ちらし型 8卓（各8名）',
      make: () => gridTables([0.16, 0.38, 0.62, 0.84], [0.4, 0.74], 8),
    },
    {
      key: 'round10',
      name: '円卓ちらし型 10卓（各8名）',
      make: () => gridTables([0.12, 0.31, 0.5, 0.69, 0.88], [0.4, 0.74], 8),
    },
    {
      key: 'comb',
      name: '長テーブル くし型 4本（各12名）',
      make: () => gridTables([0.2, 0.4, 0.6, 0.8], [0.62], 12, 'rectv'),
    },
  ],
  tall: [
    {
      key: 'round8',
      name: '円卓ちらし型 8卓（各8名）',
      make: () => gridTables([0.28, 0.72], [0.27, 0.47, 0.67, 0.87], 8),
    },
    {
      key: 'comb',
      name: '長テーブル くし型 4本（2列×2段・各12名）',
      make: () => gridTables([0.3, 0.7], [0.38, 0.74], 12, 'rectv'),
    },
    {
      key: 'banquet',
      name: '長テーブル 横並び 6本（各10名）',
      make: () => gridTables([0.27, 0.73], [0.32, 0.56, 0.8], 10, 'rect'),
    },
  ],
};

export function findTemplate(hall: HallShape, key: string): LayoutTemplate | undefined {
  return LAYOUT_TEMPLATES[hall].find((t) => t.key === key);
}

// ---------------------------------------------------------------- 席次のルール
/**
 * 席次の一般的な決まり（ブライダル各社の解説による）:
 *   - ゲストから高砂を見て左が新郎側、右が新婦側
 *   - 高砂に近いほど上座。職場関係・恩師（主賓を含む）→ 友人 → 親族・家族 の順に後ろへ
 */
export const RULE_GROUPS: { name: string; relationships: GuestRelationship[] }[] = [
  { name: '職場', relationships: ['colleague', 'teacher'] },
  { name: '友人', relationships: ['friend', 'other'] },
  { name: '親族', relationships: ['relative', 'family'] },
];

/** 新郎側・新婦側それぞれ、RULE_GROUPS の区分ごとの出席人数 */
export type RuleNeeds = Record<PartnerRole, number[]>;

export interface RuleGuest {
  attending: boolean;
  guestSide: PartnerRole | null;
  relationship: GuestRelationship | null;
  /** この回答で出席する人数（本人＋同伴者） */
  people: number;
}

/** 出席の回答から、区分ごとの人数を数える。新郎新婦側・ご関係が無い回答は数えない */
export function needsFrom(responses: RuleGuest[]): RuleNeeds {
  const count = (side: PartnerRole) =>
    RULE_GROUPS.map((group) =>
      responses
        .filter(
          (r) =>
            r.attending &&
            r.guestSide === side &&
            r.relationship !== null &&
            group.relationships.includes(r.relationship),
        )
        .reduce((sum, r) => sum + r.people, 0),
    );
  return { groom: count('groom'), bride: count('bride') };
}

const SIDE_NAME: Record<PartnerRole, string> = { groom: '新郎', bride: '新婦' };

/**
 * 卓を左右に分け、高砂に近い卓（同じ段なら中央寄り）から順に区分を割り当てる。
 *   - 区分ごとの卓の数は、出席人数と定員から決める。人数の無い区分は飛ばす
 *   - 卓が足りなければ、人数の少ない区分を隣とまとめる
 *   - 真ん中の列の卓（x = 0.5）は、出席者の多い側にまとめて振る
 *   - どの卓も新郎側か新婦側のどちらかになり、混ざらない
 * 卓の位置・形・定員は変えず、名前と座れる人だけを付け直した新しい配列を返す。
 */
export function applyRules(tables: SeatingTable[], needs: RuleNeeds): SeatingTable[] {
  const total = (side: PartnerRole) => needs[side].reduce((a, n) => a + n, 0);
  const centerSide: PartnerRole = total('bride') > total('groom') ? 'bride' : 'groom';
  const sideOf = (t: SeatingTable): PartnerRole =>
    t.x < 0.5 ? 'groom' : t.x > 0.5 ? 'bride' : centerSide;
  const result = tables.map((t) => ({ ...t, allowedTags: [...t.allowedTags] }));

  for (const side of ['groom', 'bride'] as const) {
    const list = result
      .filter((t) => sideOf(t) === side)
      .sort((a, b) => a.y - b.y || Math.abs(a.x - 0.5) - Math.abs(b.x - 0.5));
    if (!list.length) continue;

    let groups = RULE_GROUPS.map((group, i) => ({
      names: [group.name],
      relationships: [...group.relationships],
      need: needs[side][i] ?? 0,
    })).filter((g) => g.need > 0);
    // 回答がまだ無いときは、3区分とも1人ずついるものとして振る
    if (!groups.length) {
      groups = RULE_GROUPS.map((group) => ({
        names: [group.name],
        relationships: [...group.relationships],
        need: 1,
      }));
    }
    while (groups.length > list.length) {
      let k = 0;
      groups.forEach((g, i) => {
        if (g.need < groups[k].need) k = i;
      });
      const a = k === groups.length - 1 ? k - 1 : k;
      const b = a + 1;
      groups.splice(a, 2, {
        names: [...groups[a].names, ...groups[b].names],
        relationships: [...groups[a].relationships, ...groups[b].relationships],
        need: groups[a].need + groups[b].need,
      });
    }

    const avg = list.reduce((s, t) => s + t.capacity, 0) / list.length;
    const alloc = groups.map((g) => Math.max(1, Math.ceil(g.need / avg)));
    const sum = () => alloc.reduce((s, n) => s + n, 0);
    while (sum() > list.length) alloc[alloc.indexOf(Math.max(...alloc))]--;
    // 余った卓は、1卓あたりの人数がいちばん多い区分に足す
    while (sum() < list.length) {
      let i = 0;
      groups.forEach((g, k) => {
        if (g.need / alloc[k] > groups[i].need / alloc[i]) i = k;
      });
      alloc[i]++;
    }

    let pos = 0;
    groups.forEach((g, i) => {
      for (let n = 0; n < alloc[i]; n++) {
        const t = list[pos++];
        t.allowedTags = [`side:${side}`, ...g.relationships.map((r) => `relationship:${r}`)];
        t.name = SIDE_NAME[side] + g.names.join('・') + (alloc[i] > 1 ? String(n + 1) : '');
      }
    });
  }
  return result;
}

// ------------------------------------------------------------ 座れる人の判定
const tagKind = (key: string) => {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
};

/**
 * 卓の「座れる人」に、ゲストのタグ（キーの一覧）が合うか。
 * 同じ種類のキーどうしは「または」、種類が違えば「かつ」。空ならだれでも座れる。
 */
export function tableAccepts(allowedTags: string[], guestTagKeys: string[]): boolean {
  const byKind = new Map<string, string[]>();
  for (const key of allowedTags) {
    const kind = tagKind(key);
    byKind.set(kind, [...(byKind.get(kind) ?? []), key]);
  }
  const have = new Set(guestTagKeys);
  return [...byKind.values()].every((keys) => keys.some((key) => have.has(key)));
}

/** 卓の合計の席数 */
export const totalSeats = (tables: Pick<SeatingTable, 'capacity'>[]) =>
  tables.reduce((s, t) => s + t.capacity, 0);
