/**
 * 席次（#180 配置パターン / #181 席次作成・提出 / #182 承認・差し戻し）の D1 版。
 *
 * Supabase版（migrations 20261106000100 / 20261107000100）の規則を、D1 向けに
 * このモジュールの関数へ移したもの。書き込みはここだけが行い、次を毎回確かめる。
 *
 *   - 参照: 案件に触れられる利用者（scope）。ただし新郎新婦は送られた配置パターンだけ
 *   - 配置の変更: 担当スタッフ（担当プランナー・式場管理者・システム管理者）だけ
 *   - 席次の変更: 新郎新婦だけ。状態が draft / returned のときだけ
 *   - アーカイブ済みの案件は変更できない
 *   - 保存・提出は読み込んだときの版（version）を送り、進んでいたら 409 で断る（楽観ロック）
 *   - 割り当ては DB 側でも検証する: 選んだパターンの卓か、定員、出席かつ確認済みの人か、
 *     卓の「座れる人」（src/lib/seating/layout.ts の tableAccepts と同じ判定）
 *
 * 承認・差し戻し（#182）と提出は、既存の notifications（アプリ内通知）で相手へ届ける。
 */
import { randomUUID } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { z } from 'zod';
import type { AppUser } from '@/lib/auth/session';
import { conflict, forbidden, notFound, unprocessable } from '@/lib/errors';
import { tableAccepts, LAYOUTS_PER_CASE_MAX, type HallShape, type SeatingTable, type TableShape } from '@/lib/seating/layout';
import type { Seating } from '@/lib/seating/assign';
import type {
  seatingChartReviewSchema,
  seatingChartSaveSchema,
  seatingLayoutSchema,
} from '@/lib/validation';
import { scope } from './cases';

type Actor = Pick<AppUser, 'id'>;

export interface SeatingLayout {
  id: string;
  name: string;
  hallShape: HallShape;
  /** 新郎新婦に送った日時。送っていなければ null */
  offeredAt: string | null;
  tables: (SeatingTable & { id: string })[];
}

export const SEATING_CHART_STATUSES = ['draft', 'submitted', 'approved', 'returned'] as const;
export type SeatingChartStatus = (typeof SEATING_CHART_STATUSES)[number];

export interface SeatingChart {
  status: SeatingChartStatus;
  version: number;
  layoutId: string | null;
  /** プランナーからのご連絡（修正のお願い） */
  feedback: string | null;
  submittedAt: string | null;
  seating: Seating;
}

const visible = `EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=? AND ${scope})`;

interface CaseHead {
  venue_id: string;
  primary_planner_id: string;
  archived_at: string | null;
}

async function assertVisible(db: D1Database, user: Actor, caseId: string): Promise<CaseHead> {
  const row = await db
    .prepare(`SELECT c.venue_id, c.primary_planner_id, c.archived_at FROM wedding_cases c WHERE c.id=? AND ${scope}`)
    .bind(caseId, user.id)
    .first<CaseHead>();
  if (!row) throw notFound('案件が見つかりません');
  return row;
}

async function actorRole(db: D1Database, user: Actor) {
  const row = await db
    .prepare(`SELECT role, venue_id FROM user_profiles WHERE id=? AND status='active'`)
    .bind(user.id)
    .first<{ role: string; venue_id: string | null }>();
  if (!row) throw forbidden();
  return row;
}

const isStaffRole = (role: string) => role === 'planner' || role === 'admin' || role === 'system_admin';

/** 担当スタッフ（Supabase版 assert_seating_editable と同じ範囲）で、アーカイブ済みでないこと。 */
async function assertStaffEditable(db: D1Database, user: Actor, caseId: string, what: string) {
  const head = await assertVisible(db, user, caseId);
  if (head.archived_at) throw unprocessable(`アーカイブ済みの案件の${what}は変更できません`);
  const actor = await actorRole(db, user);
  const staff =
    actor.role === 'system_admin' ||
    (actor.venue_id === head.venue_id &&
      (actor.role === 'admin' || (actor.role === 'planner' && head.primary_planner_id === user.id)));
  if (!staff) throw forbidden();
  return head;
}

/** 新郎新婦本人で、アーカイブ済みでないこと。 */
async function assertCoupleEditable(db: D1Database, user: Actor, caseId: string) {
  const head = await assertVisible(db, user, caseId);
  if (head.archived_at) throw unprocessable('アーカイブ済みの案件の席次は変更できません');
  const couple = await db
    .prepare('SELECT 1 AS ok FROM couple_profiles WHERE case_id=? AND user_id=?')
    .bind(caseId, user.id)
    .first();
  if (!couple) throw forbidden();
  return head;
}

// ------------------------------------------------------------ 配置パターンの読み取り
interface LayoutRow {
  id: string;
  name: string;
  hall_shape: HallShape;
  offered_at: string | null;
}
interface TableRow {
  id: string;
  layout_id: string;
  name: string;
  capacity: number;
  shape: TableShape;
  pos_x: number;
  pos_y: number;
  allowed_tags: string;
  sort_order: number;
}

const parseTags = (raw: string): string[] => {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

/** 案件の配置パターンを作成順に読む。新郎新婦には送られたものだけを返す。 */
export async function loadSeatingLayouts(
  db: D1Database,
  user: Actor,
  caseId: string,
): Promise<SeatingLayout[]> {
  await assertVisible(db, user, caseId);
  const actor = await actorRole(db, user);
  const staff = isStaffRole(actor.role);
  const layouts = await db
    .prepare(
      `SELECT id, name, hall_shape, offered_at FROM seating_layouts
       WHERE case_id=? AND ${visible}${staff ? '' : ' AND offered_at IS NOT NULL'}
       ORDER BY created_at, id`,
    )
    .bind(caseId, caseId, user.id)
    .all<LayoutRow>();
  if (!layouts.results.length) return [];
  const ids = layouts.results.map((l) => l.id);
  const tables = await db
    .prepare(
      `SELECT * FROM seating_tables WHERE layout_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order, id`,
    )
    .bind(...ids)
    .all<TableRow>();
  const byLayout = new Map<string, TableRow[]>();
  for (const t of tables.results) byLayout.set(t.layout_id, [...(byLayout.get(t.layout_id) ?? []), t]);
  return layouts.results.map((row) => ({
    id: row.id,
    name: row.name,
    hallShape: row.hall_shape,
    offeredAt: row.offered_at,
    tables: (byLayout.get(row.id) ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      capacity: t.capacity,
      shape: t.shape,
      x: t.pos_x,
      y: t.pos_y,
      allowedTags: parseTags(t.allowed_tags),
    })),
  }));
}

// ------------------------------------------------------------ 配置パターンの保存・送付・削除
type LayoutInput = z.infer<typeof seatingLayoutSchema>;

/** 卓の「座れる人」のキーを、重複を除いて送られた順のままにする（Supabase版 seating_tag_list と同じ）。 */
const dedupeTags = (tags: string[]) => [...new Set(tags)];

async function assertTagsUsable(db: D1Database, caseId: string, input: LayoutInput) {
  const customIds = [
    ...new Set(input.tables.flatMap((t) => t.allowedTags).filter((k) => k.startsWith('tag:')).map((k) => k.slice(4))),
  ];
  if (!customIds.length) return;
  const found = await db
    .prepare(`SELECT count(*) AS n FROM case_guest_tags WHERE case_id=? AND id IN (${customIds.map(() => '?').join(',')})`)
    .bind(caseId, ...customIds)
    .first<{ n: number }>();
  if (found?.n !== customIds.length)
    throw unprocessable('卓の「座れる人」に使えない条件があります');
}

/**
 * 配置パターンの保存。layoutId が null なら新規、あれば名前・会場の形・卓をまとめて置き換える。
 * 卓は ID の付いたものを更新し、ID の無いものだけを追加する（保存し直しても卓の ID が変わらない）。
 * 送らなかった卓は消える（その卓の割り当ては外部キーの CASCADE で未配置に戻る）。
 */
export async function saveSeatingLayout(
  db: D1Database,
  user: Actor,
  caseId: string,
  layoutId: string | null,
  input: LayoutInput,
): Promise<string> {
  await assertStaffEditable(db, user, caseId, '卓の配置');
  await assertTagsUsable(db, caseId, input);
  const now = new Date().toISOString();

  let id = layoutId;
  if (id) {
    const existing = await db
      .prepare('SELECT id FROM seating_layouts WHERE id=? AND case_id=?')
      .bind(id, caseId)
      .first();
    if (!existing) throw notFound('配置パターンが見つかりません');
  } else {
    const count = await db
      .prepare('SELECT count(*) AS n FROM seating_layouts WHERE case_id=?')
      .bind(caseId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= LAYOUTS_PER_CASE_MAX)
      throw unprocessable(`配置パターンは1つの案件に${LAYOUTS_PER_CASE_MAX}個まで作れます`);
    id = randomUUID();
  }

  // ID の付いた卓は、このパターンの卓でなければならない（別パターンの卓を書き換えさせない）
  const givenIds = input.tables.flatMap((t) => (t.id ? [t.id] : []));
  if (givenIds.length) {
    const owned = await db
      .prepare(`SELECT count(*) AS n FROM seating_tables WHERE layout_id=? AND id IN (${givenIds.map(() => '?').join(',')})`)
      .bind(id, ...givenIds)
      .first<{ n: number }>();
    if (owned?.n !== givenIds.length) throw unprocessable('別の配置パターンの卓は変更できません');
  }

  const statements = [
    layoutId
      ? db
          .prepare('UPDATE seating_layouts SET name=?, hall_shape=?, updated_at=? WHERE id=? AND case_id=?')
          .bind(input.name, input.hallShape, now, id, caseId)
      : db
          .prepare(
            'INSERT INTO seating_layouts (id, case_id, name, hall_shape, created_by_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          )
          .bind(id, caseId, input.name, input.hallShape, user.id, now, now),
    ...(givenIds.length
      ? [
          db
            .prepare(`DELETE FROM seating_tables WHERE layout_id=? AND id NOT IN (${givenIds.map(() => '?').join(',')})`)
            .bind(id, ...givenIds),
        ]
      : [db.prepare('DELETE FROM seating_tables WHERE layout_id=?').bind(id)]),
    ...input.tables.map((t, i) =>
      t.id
        ? db
            .prepare(
              'UPDATE seating_tables SET name=?, capacity=?, shape=?, pos_x=?, pos_y=?, allowed_tags=?, sort_order=?, updated_at=? WHERE id=? AND layout_id=?',
            )
            .bind(t.name, t.capacity, t.shape, Math.round(t.x * 1000) / 1000, Math.round(t.y * 1000) / 1000, JSON.stringify(dedupeTags(t.allowedTags)), i, now, t.id, id)
        : db
            .prepare(
              'INSERT INTO seating_tables (id, layout_id, name, capacity, shape, pos_x, pos_y, allowed_tags, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            )
            .bind(randomUUID(), id, t.name, t.capacity, t.shape, Math.round(t.x * 1000) / 1000, Math.round(t.y * 1000) / 1000, JSON.stringify(dedupeTags(t.allowedTags)), i, now, now),
    ),
  ];
  await db.batch(statements);
  return id;
}

async function layoutCase(db: D1Database, layoutId: string): Promise<string> {
  const row = await db
    .prepare('SELECT case_id FROM seating_layouts WHERE id=?')
    .bind(layoutId)
    .first<{ case_id: string }>();
  if (!row) throw notFound('配置パターンが見つかりません');
  return row.case_id;
}

/** 新郎新婦へ送る／送るのをやめる。送った日時が入っている間だけ新郎新婦に見える。 */
export async function setSeatingLayoutOffered(
  db: D1Database,
  user: Actor,
  layoutId: string,
  offered: boolean,
) {
  const caseId = await layoutCase(db, layoutId);
  await assertStaffEditable(db, user, caseId, '卓の配置');
  const now = new Date().toISOString();
  const { changes } = (
    await db
      .prepare(
        offered
          ? 'UPDATE seating_layouts SET offered_at=COALESCE(offered_at, ?), updated_at=? WHERE id=?'
          : 'UPDATE seating_layouts SET offered_at=NULL, updated_at=? WHERE id=?',
      )
      .bind(...(offered ? [now, now, layoutId] : [now, layoutId]))
      .run()
  ).meta;
  if (!changes) throw notFound('配置パターンが見つかりません');
}

export async function deleteSeatingLayout(db: D1Database, user: Actor, layoutId: string) {
  const caseId = await layoutCase(db, layoutId);
  await assertStaffEditable(db, user, caseId, '卓の配置');
  const { changes } = (
    await db.prepare('DELETE FROM seating_layouts WHERE id=?').bind(layoutId).run()
  ).meta;
  if (!changes) throw notFound('配置パターンが見つかりません');
}

// ------------------------------------------------------------ ゲストのキーと割り当ての検証
/**
 * ゲストのタグのキー（Supabase版 seating_guest_keys と同じ。ご関係は直した値を優先する）。
 * D1 では assistance_needs が JSON 文字列、allergy は暗号文の有無ではなく保存値の有無で見る
 * （loadGuestBook と同じく、復号は表示層の仕事なので、ここでは空でないことだけを見る）。
 */
async function guestKeysById(db: D1Database, caseId: string): Promise<Map<string, string[]>> {
  const [guests, links] = await db.batch([
    db
      .prepare(
        'SELECT id, guest_side, relationship, relationship_override, age_category, allergy_note, seat_role, assistance_needs FROM case_guests WHERE case_id=?',
      )
      .bind(caseId),
    db
      .prepare(
        'SELECT l.guest_id, l.tag_id FROM case_guest_tag_links l JOIN case_guests g ON g.id=l.guest_id WHERE g.case_id=?',
      )
      .bind(caseId),
  ]);
  const tags = new Map<string, string[]>();
  for (const link of links.results as { guest_id: string; tag_id: string }[])
    tags.set(link.guest_id, [...(tags.get(link.guest_id) ?? []), `tag:${link.tag_id}`]);
  const map = new Map<string, string[]>();
  for (const g of guests.results as {
    id: string;
    guest_side: string | null;
    relationship: string | null;
    relationship_override: string | null;
    age_category: string | null;
    allergy_note: string | null;
    seat_role: string | null;
    assistance_needs: string;
  }[]) {
    let needs: string[] = [];
    try {
      const parsed = JSON.parse(g.assistance_needs);
      if (Array.isArray(parsed)) needs = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      needs = [];
    }
    const relationship = g.relationship_override ?? g.relationship;
    map.set(g.id, [
      ...(g.guest_side ? [`side:${g.guest_side}`] : []),
      ...(relationship ? [`relationship:${relationship}`] : []),
      ...(g.age_category ? [`age:${g.age_category}`] : []),
      ...(g.allergy_note ? ['allergy'] : []),
      ...(g.seat_role ? [`role:${g.seat_role}`] : []),
      ...needs.map((n) => `assistance:${n}`),
      ...(tags.get(g.id) ?? []),
    ]);
  }
  return map;
}

async function eligibleGuestIds(db: D1Database, caseId: string): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT id FROM case_guests WHERE case_id=? AND invitation_status='reply_yes' AND checked_at IS NOT NULL`,
    )
    .bind(caseId)
    .all<{ id: string }>();
  return new Set(rows.results.map((r) => r.id));
}

interface Assignment {
  guestId: string;
  tableId: string;
}

/** 割り当てが、配置パターン・ゲスト・卓の条件・定員に合っているかを確かめる（Supabase版 assert_seating_assignments_valid と同じ）。 */
async function assertAssignmentsValid(
  db: D1Database,
  caseId: string,
  layoutId: string,
  assignments: Assignment[],
) {
  const guestIds = assignments.map((a) => a.guestId);
  if (new Set(guestIds).size !== guestIds.length)
    throw unprocessable('同じ方を2つの席に入れることはできません');
  const tables = await db
    .prepare('SELECT id, capacity, allowed_tags FROM seating_tables WHERE layout_id=?')
    .bind(layoutId)
    .all<{ id: string; capacity: number; allowed_tags: string }>();
  const tableById = new Map(tables.results.map((t) => [t.id, t]));
  if (assignments.some((a) => !tableById.has(a.tableId)))
    throw unprocessable('選んだ配置パターンにない卓があります');
  const [eligible, keys] = await Promise.all([eligibleGuestIds(db, caseId), guestKeysById(db, caseId)]);
  if (assignments.some((a) => !eligible.has(a.guestId)))
    throw unprocessable('席次に入れられるのは、出席で確認済みの方だけです');
  const counts = new Map<string, number>();
  for (const a of assignments) {
    counts.set(a.tableId, (counts.get(a.tableId) ?? 0) + 1);
    const table = tableById.get(a.tableId)!;
    if (!tableAccepts(parseTags(table.allowed_tags), keys.get(a.guestId) ?? []))
      throw unprocessable('卓の「座れる人」の条件に合わない方がいます');
  }
  for (const [tableId, n] of counts)
    if (n > tableById.get(tableId)!.capacity) throw unprocessable('定員を超えている卓があります');
}

// ------------------------------------------------------------ 席次の読み取り
interface ChartRow {
  status: SeatingChartStatus;
  version: number;
  layout_id: string | null;
  feedback: string | null;
  submitted_at: string | null;
}

/** 案件の席次を読む。席次の行がまだ無い案件は、下書き・版 0・未配置として返す。 */
export async function loadSeatingChart(
  db: D1Database,
  user: Actor,
  caseId: string,
): Promise<SeatingChart> {
  await assertVisible(db, user, caseId);
  const [chart, assignments] = await db.batch([
    db
      .prepare('SELECT status, version, layout_id, feedback, submitted_at FROM seating_charts WHERE case_id=?')
      .bind(caseId),
    db
      .prepare(
        `SELECT guest_id, table_id, seat_order FROM seating_assignments WHERE case_id=? AND ${visible} ORDER BY table_id, seat_order`,
      )
      .bind(caseId, caseId, user.id),
  ]);
  const seating: Seating = {};
  for (const row of assignments.results as { guest_id: string; table_id: string }[])
    (seating[row.table_id] ??= []).push(row.guest_id);
  const row = (chart.results as unknown as ChartRow[])[0];
  return {
    status: row?.status ?? 'draft',
    version: row?.version ?? 0,
    layoutId: row?.layout_id ?? null,
    feedback: row?.feedback ?? null,
    submittedAt: row?.submitted_at ?? null,
    seating,
  };
}

async function chartRow(db: D1Database, caseId: string): Promise<ChartRow | null> {
  return db
    .prepare('SELECT status, version, layout_id, feedback, submitted_at FROM seating_charts WHERE case_id=?')
    .bind(caseId)
    .first<ChartRow>();
}

/** 席次を変更できる前提（状態と版）を確かめる。Supabase版 lock_seating_chart_for_couple と同じ規則。 */
function assertChartWritable(chart: ChartRow | null, version: number) {
  const status = chart?.status ?? 'draft';
  if (status !== 'draft' && status !== 'returned')
    throw unprocessable('提出済みの席次は変更できません');
  if ((chart?.version ?? 0) !== version)
    throw conflict('もう一人が先に席次を保存しました。最新の内容を読み込み直してから、もう一度操作してください');
}

// ------------------------------------------------------------ 席次の保存・提出
type ChartSaveInput = z.infer<typeof seatingChartSaveSchema>;

/**
 * 席次の保存。送らなかった人は未配置になる。同じ卓の人は、送った並びがそのまま席順になる。
 * 戻り値は保存後の版。
 */
export async function saveSeatingChart(
  db: D1Database,
  user: Actor,
  caseId: string,
  input: ChartSaveInput,
): Promise<number> {
  await assertCoupleEditable(db, user, caseId);
  const chart = await chartRow(db, caseId);
  assertChartWritable(chart, input.version);

  if (input.layoutId !== null) {
    const layout = await db
      .prepare('SELECT offered_at FROM seating_layouts WHERE id=? AND case_id=?')
      .bind(input.layoutId, caseId)
      .first<{ offered_at: string | null }>();
    if (!layout || !layout.offered_at)
      throw unprocessable('プランナーから届いた配置パターンを選んでください');
    await assertAssignmentsValid(db, caseId, input.layoutId, input.assignments);
  } else if (input.assignments.length > 0) {
    throw unprocessable('先に配置パターンを選んでください');
  }

  const now = new Date().toISOString();
  const nextVersion = (chart?.version ?? 0) + 1;
  // 卓ごとの席順は、送られた並びの中でその卓が何番目に出てきたかで決める
  const perTable = new Map<string, number>();
  const seatOrder = input.assignments.map((a) => {
    const n = perTable.get(a.tableId) ?? 0;
    perTable.set(a.tableId, n + 1);
    return n;
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO seating_charts (case_id, layout_id, status, version, updated_by_user_id, created_at, updated_at)
         VALUES (?,?,'draft',?,?,?,?)
         ON CONFLICT(case_id) DO UPDATE SET layout_id=excluded.layout_id,
           status=CASE WHEN seating_charts.status='returned' THEN 'returned' ELSE 'draft' END,
           version=excluded.version, updated_by_user_id=excluded.updated_by_user_id, updated_at=excluded.updated_at`,
      )
      .bind(caseId, input.layoutId, nextVersion, user.id, now, now),
    db.prepare('DELETE FROM seating_assignments WHERE case_id=?').bind(caseId),
    ...input.assignments.map((a, i) =>
      db
        .prepare('INSERT INTO seating_assignments (guest_id, case_id, table_id, seat_order, created_at) VALUES (?,?,?,?,?)')
        .bind(a.guestId, caseId, a.tableId, seatOrder[i], now),
    ),
  ]);
  return nextVersion;
}

/** 席次の提出。全員の席が決まり、条件と定員に合っているときだけ提出できる。提出後は変更できない。 */
export async function submitSeatingChart(
  db: D1Database,
  user: Actor,
  caseId: string,
  version: number,
): Promise<number> {
  const head = await assertCoupleEditable(db, user, caseId);
  const chart = await chartRow(db, caseId);
  assertChartWritable(chart, version);
  if (!chart?.layout_id) throw unprocessable('配置パターンを選んで席を決めてから提出してください');
  const layout = await db
    .prepare('SELECT offered_at FROM seating_layouts WHERE id=?')
    .bind(chart.layout_id)
    .first<{ offered_at: string | null }>();
  if (!layout?.offered_at) throw unprocessable('配置パターンを選んで席を決めてから提出してください');

  const stored = await db
    .prepare('SELECT guest_id, table_id FROM seating_assignments WHERE case_id=? ORDER BY table_id, seat_order')
    .bind(caseId)
    .all<{ guest_id: string; table_id: string }>();
  const assignments = stored.results.map((r) => ({ guestId: r.guest_id, tableId: r.table_id }));
  await assertAssignmentsValid(db, caseId, chart.layout_id, assignments);
  const placed = new Set(assignments.map((a) => a.guestId));
  const eligible = await eligibleGuestIds(db, caseId);
  const unplaced = [...eligible].filter((id) => !placed.has(id)).length;
  if (unplaced > 0) throw unprocessable(`まだ席の決まっていない方が${unplaced}名います`);

  const now = new Date().toISOString();
  const nextVersion = chart.version + 1;
  await db.batch([
    db
      .prepare(
        `UPDATE seating_charts SET status='submitted', submitted_at=?, version=?, updated_by_user_id=?, updated_at=? WHERE case_id=?`,
      )
      .bind(now, nextVersion, user.id, now, caseId),
    db
      .prepare(
        `INSERT INTO notifications (id, case_id, recipient_user_id, channel, notification_type, title, body, link_path, status, sent_at, created_at)
         VALUES (?,?,?,'in_app','info','席次が提出されました','新郎新婦から席次が提出されました。案件詳細でご確認ください。',?,'sent',?,?)`,
      )
      .bind(randomUUID(), caseId, head.primary_planner_id, `/cases/${caseId}`, now, now),
  ]);
  return nextVersion;
}

// ------------------------------------------------------------ 席次の承認・差し戻し（#182）
type ChartReviewInput = z.infer<typeof seatingChartReviewSchema>;

/**
 * プランナーが提出された席次を確認する。承認で確定し、差し戻すと新郎新婦が再び編集できる。
 * 結果はアプリ内通知で新郎新婦（アカウントのある方全員）へ届ける。
 */
export async function reviewSeatingChart(
  db: D1Database,
  user: Actor,
  caseId: string,
  input: ChartReviewInput,
): Promise<{ status: SeatingChartStatus; version: number }> {
  await assertStaffEditable(db, user, caseId, '席次');
  const chart = await chartRow(db, caseId);
  if (!chart || chart.status !== 'submitted')
    throw unprocessable('提出済みの席次だけ確認できます');
  const now = new Date().toISOString();
  const nextVersion = chart.version + 1;
  const feedback = input.feedback?.trim() ? input.feedback.trim() : null;
  const approved = input.decision === 'approved';
  const couples = await db
    .prepare('SELECT user_id FROM couple_profiles WHERE case_id=? AND user_id IS NOT NULL')
    .bind(caseId)
    .all<{ user_id: string }>();
  await db.batch([
    db
      .prepare(
        'UPDATE seating_charts SET status=?, feedback=?, version=?, updated_by_user_id=?, updated_at=? WHERE case_id=?',
      )
      .bind(input.decision, feedback, nextVersion, user.id, now, caseId),
    ...couples.results.map((c) =>
      db
        .prepare(
          `INSERT INTO notifications (id, case_id, recipient_user_id, channel, notification_type, title, body, link_path, status, sent_at, created_at)
           VALUES (?,?,?,'in_app',?,?,?,'/mypage/seating','sent',?,?)`,
        )
        .bind(
          randomUUID(),
          caseId,
          c.user_id,
          approved ? 'info' : 'needs_fix',
          approved ? '席次が確定しました' : '席次の修正のお願い',
          approved
            ? feedback
              ? `席次が確定しました。プランナーから: ${feedback}`
              : '席次が確定しました。内容はマイページの席次でご確認ください。'
            : `席次の修正をお願いします。${feedback ?? ''}`,
          now,
          now,
        ),
    ),
  ]);
  return { status: input.decision, version: nextVersion };
}
