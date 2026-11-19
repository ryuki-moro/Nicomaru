/**
 * 新郎新婦が席次をつくるときの割り振り（#181）。
 *
 * 席次プロトタイプの placeGuest・placementWish・autoAssign を移したもの。
 * 画面（ブラウザー）で使うので、DB や node: のモジュールに依存しない。
 * 保存のときは DB（save_seating_chart()）も卓の条件と定員を確かめる。
 *
 * 席次は「卓の ID → 席順に並んだゲストの ID」で持つ（Seating）。
 */
import type {
  GuestAgeCategory,
  GuestAssistanceNeed,
  GuestSeatRole,
  PartnerRole,
} from '@/lib/constants';
import { tableAccepts } from '@/lib/seating/layout';

export interface SeatGuest {
  id: string;
  /** 同じ回答（本人＋同伴者）に共通の ID。家族・同伴者をまとめるのに使う */
  groupId: string;
  side: PartnerRole | null;
  ageCategory: GuestAgeCategory | null;
  assistanceNeeds: GuestAssistanceNeed[];
  seatRole: GuestSeatRole | null;
  /** ゲストのタグのキー（src/lib/guest-tags.ts）。卓の「座れる人」と照らし合わせる */
  tagKeys: string[];
}

export interface SeatTable {
  id: string;
  name: string;
  capacity: number;
  x: number;
  y: number;
  allowedTags: string[];
}

/** 卓の ID → 席順に並んだゲストの ID */
export type Seating = Record<string, string[]>;

export const canSeat = (table: Pick<SeatTable, 'allowedTags'>, guest: Pick<SeatGuest, 'tagKeys'>) =>
  tableAccepts(table.allowedTags, guest.tagKeys);

export const tableOf = (seating: Seating, guestId: string): string | null =>
  Object.keys(seating).find((tableId) => seating[tableId].includes(guestId)) ?? null;

const cloneSeating = (seating: Seating): Seating =>
  Object.fromEntries(Object.entries(seating).map(([k, v]) => [k, [...v]]));

const ROLE_RANK: Record<GuestSeatRole, number> = { chief: 0, toast: 1 };

/** 卓の中で 主賓 → 乾杯のご発声 → それ以外 の順に並べ直す（それ以外の並びは保つ） */
export function rolesFirst(ids: string[], byId: Map<string, SeatGuest>): string[] {
  const rank = (id: string) => {
    const role = byId.get(id)?.seatRole;
    return role ? ROLE_RANK[role] : 2;
  };
  return ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map((x) => x.id);
}

// ---------------------------------------------------------------- 席の希望
export interface PlacementWish {
  where: 'front' | 'rear';
  /** 画面に出す理由（「主賓」「子ども連れ」「車いす」など） */
  reason: string;
  role: boolean;
}

const REAR_NEEDS: GuestAssistanceNeed[] = ['mobility', 'wheelchair', 'pregnancy'];
const FRONT_NEEDS: GuestAssistanceNeed[] = ['hearing', 'vision'];
const NEED_LABEL: Partial<Record<GuestAssistanceNeed, string>> = {
  mobility: '足腰',
  wheelchair: '車いす',
  pregnancy: '妊娠中',
  hearing: '耳が聞こえにくい',
  vision: '目が見えにくい',
};
const ROLE_LABEL: Record<GuestSeatRole, string> = { chief: '主賓', toast: '乾杯のご発声' };

/** 子ども（小学生・未就学）を含む回答の ID */
export function childGroupsOf(guests: SeatGuest[]): Set<string> {
  return new Set(
    guests
      .filter((g) => g.ageCategory === 'child' || g.ageCategory === 'infant')
      .map((g) => g.groupId),
  );
}

/**
 * 前の卓（高砂に近い卓）・後ろの卓（入口に近い卓）を優先したい人か。
 *   - 前: 主賓・乾杯のご発声、耳が聞こえにくい・目が見えにくい人
 *   - 後ろ: 子ども連れ（子どもと同じ回答の家族）、足腰・車いす・妊娠中の人
 */
export function placementWish(guest: SeatGuest, childGroups: Set<string>): PlacementWish | null {
  if (guest.seatRole) return { where: 'front', reason: ROLE_LABEL[guest.seatRole], role: true };
  if (childGroups.has(guest.groupId)) {
    const reason =
      guest.ageCategory === 'child' || guest.ageCategory === 'infant' ? '子ども' : '子ども連れ';
    return { where: 'rear', reason, role: false };
  }
  const rear = guest.assistanceNeeds.filter((n) => REAR_NEEDS.includes(n));
  if (rear.length)
    return { where: 'rear', reason: rear.map((n) => NEED_LABEL[n]).join('・'), role: false };
  const front = guest.assistanceNeeds.filter((n) => FRONT_NEEDS.includes(n));
  if (front.length)
    return { where: 'front', reason: front.map((n) => NEED_LABEL[n]).join('・'), role: false };
  return null;
}

// ------------------------------------------------------------ 1人ずつ入れる
export interface PlaceResult {
  seating: Seating;
  /** 入れたゲスト（選んだ人と、一緒に入れた家族・同伴者） */
  placed: string[];
  /** 入れられなかった理由（満席・条件に合わない） */
  error?: string;
  /** 家族・同伴者を入れられなかったときの説明 */
  note?: string;
}

/**
 * 選んだ人を卓に入れる。まだ席の無い家族・同伴者（同じ回答の人）も、空きがあり条件に合えば一緒に入れる。
 * すでに別の卓にいる人は、その卓から移す（家族は一緒に動かさない）。
 */
export function placeGuest(
  seating: Seating,
  tables: SeatTable[],
  guests: SeatGuest[],
  guestId: string,
  tableId: string,
  withParty = true,
): PlaceResult {
  const table = tables.find((t) => t.id === tableId);
  const guest = guests.find((g) => g.id === guestId);
  if (!table || !guest) return { seating, placed: [], error: '卓またはゲストが見つかりません' };
  const current = tableOf(seating, guestId);
  if (current === tableId) return { seating, placed: [] };
  if (!canSeat(table, guest)) {
    return { seating, placed: [], error: `${table.name}は、この方の座れる卓ではありません` };
  }
  const members = seating[tableId] ?? [];
  const room = table.capacity - members.length;
  if (room <= 0) return { seating, placed: [], error: `${table.name}は満席です` };

  let party = [guestId];
  const notes: string[] = [];
  if (withParty && !current) {
    const mates = guests.filter(
      (g) => g.groupId === guest.groupId && g.id !== guestId && !tableOf(seating, g.id),
    );
    if (mates.length) {
      const fit = mates.filter((m) => canSeat(table, m));
      if (fit.length + 1 <= room) party = [guestId, ...fit.map((m) => m.id)];
      else notes.push(`ご家族・同伴者の${fit.length}名は、空きが足りないため入れていません`);
      if (fit.length < mates.length) {
        notes.push(`${mates.length - fit.length}名は座れる条件に合わないため、入れていません`);
      }
    }
  }

  const next = cloneSeating(seating);
  if (current) next[current] = next[current].filter((id) => id !== guestId);
  const byId = new Map(guests.map((g) => [g.id, g]));
  next[tableId] = rolesFirst([...(next[tableId] ?? []), ...party], byId);
  return { seating: next, placed: party, note: notes.length ? notes.join('。') : undefined };
}

export function unplaceGuest(seating: Seating, guestId: string): Seating {
  const next = cloneSeating(seating);
  for (const tableId of Object.keys(next))
    next[tableId] = next[tableId].filter((id) => id !== guestId);
  return next;
}

/** 卓の中で席順を1つ前（-1）または後ろ（+1）と入れ替える */
export function moveInTable(seating: Seating, guestId: string, dir: -1 | 1): Seating {
  const tableId = tableOf(seating, guestId);
  if (!tableId) return seating;
  const list = [...seating[tableId]];
  const i = list.indexOf(guestId);
  const j = i + dir;
  if (j < 0 || j >= list.length) return seating;
  [list[i], list[j]] = [list[j], list[i]];
  return { ...cloneSeating(seating), [tableId]: list };
}

// ------------------------------------------------------- ランダムに配置する
export interface AutoAssignResult {
  seating: Seating;
  placed: string[];
  fails: { guestId: string; reason: string }[];
  /** 前・後ろの希望を考えて入れた人と、その説明 */
  wishes: { guestId: string; tableId: string; wish: PlacementWish; note: string }[];
}

/** 縦の位置がこれ以内なら同じ列とみなす */
const SAME_ROW = 0.05;

/**
 * 未配置の人を、卓の条件と定員に合う卓へ入れる。決めた席は動かさない。
 *   1. 主賓・乾杯 → 後ろを優先する人 → 前を優先する人 → それ以外 の順に席を取る。
 *      同じ回答の家族・同伴者は続けて並べる
 *   2. 家族・同伴者がすでに座っている卓に空きがあれば、その卓を選ぶ
 *   3. 希望のある人は、条件に合う卓のうち いちばん後ろ（前）の列を選ぶ。
 *      同じ列では、反対側（新郎側／新婦側）の人がいない卓を先に、
 *      後ろは入口（左）に近い卓、主賓・乾杯は高砂の正面（中央寄り）、それ以外はランダム
 *   4. 希望の無い人は、反対側の人がいない卓からランダムに選ぶ
 *   5. 条件に合う卓が無い・満席の人は、理由を付けて残す
 * random はテストで結果を固定するために差し替えられる。
 */
export function autoAssign(
  seating: Seating,
  tables: SeatTable[],
  guests: SeatGuest[],
  random: () => number = Math.random,
): AutoAssignResult {
  const next = cloneSeating(seating);
  for (const t of tables) next[t.id] ??= [];
  const byId = new Map(guests.map((g) => [g.id, g]));
  const kids = childGroupsOf(guests);
  const seated = new Set(Object.values(next).flat());

  const left = guests.filter((g) => !seated.has(g.id));
  for (let i = left.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [left[i], left[j]] = [left[j], left[i]];
  }
  const rank = (g: SeatGuest) => {
    const w = placementWish(g, kids);
    return !w ? 3 : w.role ? 0 : w.where === 'rear' ? 1 : 2;
  };
  const groupRank = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  left.forEach((g, i) => {
    groupRank.set(g.groupId, Math.min(groupRank.get(g.groupId) ?? 9, rank(g)));
    if (!firstSeen.has(g.groupId)) firstSeen.set(g.groupId, i);
  });
  left.sort(
    (a, b) =>
      groupRank.get(a.groupId)! - groupRank.get(b.groupId)! ||
      firstSeen.get(a.groupId)! - firstSeen.get(b.groupId)! ||
      rank(a) - rank(b),
  );

  const members = (tableId: string) =>
    next[tableId].map((id) => byId.get(id)).filter(Boolean) as SeatGuest[];
  const result: AutoAssignResult = { seating: next, placed: [], fails: [], wishes: [] };

  for (const g of left) {
    const ok = tables.filter((t) => canSeat(t, g));
    if (!ok.length) {
      result.fails.push({ guestId: g.id, reason: '座れる条件の卓がありません' });
      continue;
    }
    const free = ok.filter((t) => next[t.id].length < t.capacity);
    if (!free.length) {
      result.fails.push({ guestId: g.id, reason: '条件に合う卓が満席です' });
      continue;
    }
    const wish = placementWish(g, kids);
    const family = free.filter((t) => members(t.id).some((m) => m.groupId === g.groupId));
    const otherSide = (t: SeatTable) => (members(t.id).some((m) => m.side !== g.side) ? 1 : 0);

    let table: SeatTable;
    if (!wish) {
      const clean = free.filter((t) => !otherSide(t));
      const pool = clean.length ? clean : free;
      table = family[0] ?? pool[Math.floor(random() * pool.length)];
    } else {
      const pool = family.length ? family : free;
      const ys = pool.map((t) => t.y);
      const edge = wish.where === 'rear' ? Math.max(...ys) : Math.min(...ys);
      const row = pool.filter((t) => Math.abs(t.y - edge) <= SAME_ROW);
      const tie = new Map(row.map((t) => [t.id, random()]));
      row.sort(
        (a, b) =>
          otherSide(a) - otherSide(b) ||
          (wish.where === 'rear'
            ? a.x - b.x
            : wish.role
              ? Math.abs(a.x - 0.5) - Math.abs(b.x - 0.5)
              : tie.get(a.id)! - tie.get(b.id)!),
      );
      table = row[0];

      const allYs = tables.map((t) => t.y);
      const hallEdge = wish.where === 'rear' ? Math.max(...allYs) : Math.min(...allYs);
      const okYs = ok.map((t) => t.y);
      const best = wish.where === 'rear' ? Math.max(...okYs) : Math.min(...okYs);
      const side = wish.where === 'rear' ? '後ろ' : '前';
      const note =
        Math.abs(table.y - hallEdge) <= SAME_ROW
          ? ''
          : Math.abs(table.y - best) > SAME_ROW
            ? `条件に合う${side}の卓が満席のため、この卓にしました`
            : `座れる条件に合う卓の中では、この卓がいちばん${side}です`;
      result.wishes.push({ guestId: g.id, tableId: table.id, wish, note });
    }
    next[table.id].push(g.id);
    result.placed.push(g.id);
  }

  for (const t of tables) next[t.id] = rolesFirst(next[t.id], byId);
  return result;
}

// --------------------------------------------------------- 提出前の確かめ
export interface SeatingCheck {
  unplaced: string[];
  /** 定員を超えている卓 */
  overTables: string[];
  /** 卓の条件に合わない席にいる人 */
  mismatched: string[];
  /** 新郎側と新婦側が同じ卓にいる卓（注意だけ。提出はできる） */
  mixedTables: string[];
}

export function checkSeating(
  seating: Seating,
  tables: SeatTable[],
  guests: SeatGuest[],
): SeatingCheck {
  const byId = new Map(guests.map((g) => [g.id, g]));
  const seated = new Set(Object.values(seating).flat());
  const check: SeatingCheck = { unplaced: [], overTables: [], mismatched: [], mixedTables: [] };
  check.unplaced = guests.filter((g) => !seated.has(g.id)).map((g) => g.id);
  for (const t of tables) {
    const ids = seating[t.id] ?? [];
    if (ids.length > t.capacity) check.overTables.push(t.id);
    const people = ids.map((id) => byId.get(id)).filter(Boolean) as SeatGuest[];
    check.mismatched.push(...people.filter((g) => !canSeat(t, g)).map((g) => g.id));
    if (new Set(people.map((g) => g.side)).size > 1) check.mixedTables.push(t.id);
  }
  return check;
}

export const canSubmit = (c: SeatingCheck) =>
  c.unplaced.length === 0 && c.overTables.length === 0 && c.mismatched.length === 0;
