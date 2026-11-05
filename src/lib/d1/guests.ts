/**
 * ゲストの出欠回答と自由タグ（D1版）。Supabase版の RLS と関数
 * （migrations/20261030000100〜300、services/guests.ts）と同じ規則をSQLの条件で表す。
 *
 * - 参照: 案件に触れられる利用者（scope）。admin はアーカイブ済みも見られる
 * - 変更: 上に加えて、アーカイブ済みの案件は拒否する
 * - 回答の登録は未ログインのゲストが行うため、回答URLのトークンだけで案件を特定する
 */
import { randomUUID } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import type { z } from 'zod';
import type { AppUser } from '@/lib/auth/session';
import { encryptPii } from '@/lib/crypto';
import { notFound, unprocessable } from '@/lib/errors';
import { GUEST_TAG_MAX_PER_CASE, type GuestCustomTag } from '@/lib/guest-tags';
import { groupGuestResponses, type GuestBook, type GuestRow } from '@/lib/services/guests';
import { generateInvitationToken, hashInvitationToken } from '@/lib/services/invitations';
import type { guestResponseSchema } from '@/lib/validation';
import { scope } from './cases';

type Actor = Pick<AppUser, 'id'>;
const visible = `EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=? AND ${scope})`;
const editable = `EXISTS(SELECT 1 FROM wedding_cases c WHERE c.id=? AND c.archived_at IS NULL AND ${scope})`;

async function assertVisible(db: D1Database, user: Actor, caseId: string) {
  const row = await db
    .prepare(`SELECT archived_at FROM wedding_cases c WHERE c.id=? AND ${scope}`)
    .bind(caseId, user.id)
    .first<{ archived_at: string | null }>();
  if (!row) throw notFound('案件が見つかりません');
  return row;
}
async function assertEditable(db: D1Database, user: Actor, caseId: string, what: string) {
  if ((await assertVisible(db, user, caseId)).archived_at)
    throw unprocessable(`アーカイブ済みの案件の${what}は変更できません`);
}

/** 有効な回答URLの暗号文。未発行なら null。 */
export async function activeGuestFormToken(db: D1Database, user: Actor, caseId: string) {
  await assertVisible(db, user, caseId);
  const row = await db
    .prepare('SELECT token_enc FROM case_guest_forms WHERE case_id=? AND revoked_at IS NULL')
    .bind(caseId)
    .first<{ token_enc: string }>();
  return row?.token_enc ?? null;
}

/** 既存の有効URLの失効と新規発行を同じbatchで行い、新しいトークンを返す。 */
export async function reissueGuestForm(db: D1Database, user: Actor, caseId: string) {
  await assertEditable(db, user, caseId, '回答URL');
  const token = generateInvitationToken();
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE case_guest_forms SET revoked_at=? WHERE case_id=? AND revoked_at IS NULL AND ${editable}`,
      )
      .bind(now, caseId, caseId, user.id),
    db
      .prepare(
        `INSERT INTO case_guest_forms (id,case_id,token_hash,token_enc,created_by_user_id,created_at) SELECT ?,?,?,?,?,? WHERE ${editable}`,
      )
      .bind(
        randomUUID(),
        caseId,
        hashInvitationToken(token),
        encryptPii(token),
        user.id,
        now,
        caseId,
        user.id,
      ),
  ]);
  if (!results[1].meta.changes) throw notFound('案件が見つかりません');
  return token;
}

const activeForm = `FROM case_guest_forms f JOIN wedding_cases c ON c.id=f.case_id WHERE f.token_hash=? AND f.revoked_at IS NULL AND c.archived_at IS NULL`;

/** 回答画面に出す挙式日と新郎新婦の氏名（暗号文）。URLが無効なら null。 */
export async function peekGuestForm(db: D1Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT c.wedding_date,
        (SELECT cp.full_name FROM couple_profiles cp WHERE cp.case_id=c.id AND cp.partner_role='groom') AS groom_name_enc,
        (SELECT cp.full_name FROM couple_profiles cp WHERE cp.case_id=c.id AND cp.partner_role='bride') AS bride_name_enc
      ${activeForm}`,
    )
    .bind(tokenHash)
    .first<{
      wedding_date: string;
      groom_name_enc: string | null;
      bride_name_enc: string | null;
    }>();
}

/** 回答（本人＋同伴者）を登録する。URLが無効なら false。 */
export async function submitGuestResponse(
  db: D1Database,
  tokenHash: string,
  input: z.infer<typeof guestResponseSchema>,
) {
  const form = await db
    .prepare(`SELECT f.case_id ${activeForm}`)
    .bind(tokenHash)
    .first<{ case_id: string }>();
  if (!form) return false;
  const group = randomUUID();
  const now = new Date().toISOString();
  // 回答中にURLが切り替わっても書き込まないよう、各行で有効性を確かめる
  const results = await db.batch(
    input.guests.map((guest, index) =>
      db
        .prepare(
          `INSERT INTO case_guests (id,case_id,full_name,kana,relationship,allergy_note,invitation_status,response_group_id,is_companion,guest_side,age_category,gender,assistance_needs,assistance_note,responded_at,created_at)
          SELECT ?,f.case_id,?,?,?,?,?,?,?,?,?,?,?,?,?,? ${activeForm}`,
        )
        .bind(
          randomUUID(),
          encryptPii(guest.fullName),
          encryptPii(guest.kana),
          input.relationship,
          input.attending ? encryptPii(guest.allergyNote) : null,
          input.attending ? 'reply_yes' : 'reply_no',
          group,
          index > 0 ? 1 : 0,
          input.guestSide,
          guest.ageCategory,
          guest.gender,
          JSON.stringify(input.attending ? [...new Set(guest.assistanceNeeds)] : []),
          input.attending ? encryptPii(guest.assistanceNote) : null,
          now,
          // 同じ回答の中で本人→同伴者の順に並ぶよう、登録時刻を1msずつずらす
          new Date(Date.parse(now) + index).toISOString(),
          tokenHash,
        ),
    ),
  );
  return results.every((result) => result.meta.changes === 1);
}

interface StoredGuest extends Omit<GuestRow, 'is_companion' | 'assistance_needs'> {
  is_companion: number;
  assistance_needs: string;
}

/** 案件の回答と自由タグを読み、回答単位にまとめて返す。 */
export async function loadGuestBook(
  db: D1Database,
  user: Actor,
  caseId: string,
): Promise<GuestBook> {
  await assertVisible(db, user, caseId);
  const [guests, links, tags] = await db.batch([
    db
      .prepare(`SELECT * FROM case_guests WHERE case_id=? AND ${visible}`)
      .bind(caseId, caseId, user.id),
    db
      .prepare(
        `SELECT l.guest_id,l.tag_id FROM case_guest_tag_links l JOIN case_guests g ON g.id=l.guest_id WHERE g.case_id=? AND ${visible}`,
      )
      .bind(caseId, caseId, user.id),
    db
      .prepare(
        `SELECT id,name FROM case_guest_tags WHERE case_id=? AND ${visible} ORDER BY created_at,id`,
      )
      .bind(caseId, caseId, user.id),
  ]);
  const tagIds = new Map<string, { tag_id: string }[]>();
  for (const link of links.results as { guest_id: string; tag_id: string }[])
    tagIds.set(link.guest_id, [...(tagIds.get(link.guest_id) ?? []), { tag_id: link.tag_id }]);
  return {
    responses: groupGuestResponses(
      (guests.results as unknown as StoredGuest[]).map((row) => ({
        ...row,
        is_companion: row.is_companion === 1,
        assistance_needs: JSON.parse(row.assistance_needs),
        case_guest_tag_links: tagIds.get(row.id) ?? [],
      })),
    ),
    tags: tags.results as unknown as GuestCustomTag[],
  };
}

const duplicateTag = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed/.test(error.message)
    ? unprocessable('同じ名前のタグがすでにあります')
    : error;

export async function createGuestTag(db: D1Database, user: Actor, caseId: string, name: string) {
  await assertEditable(db, user, caseId, 'タグ');
  const id = randomUUID();
  let changes;
  try {
    changes = (
      await db
        .prepare(
          `INSERT INTO case_guest_tags (id,case_id,name,created_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM case_guest_tags WHERE case_id=?)<? AND ${editable}`,
        )
        .bind(
          id,
          caseId,
          name,
          new Date().toISOString(),
          caseId,
          GUEST_TAG_MAX_PER_CASE,
          caseId,
          user.id,
        )
        .run()
    ).meta.changes;
  } catch (error) {
    throw duplicateTag(error);
  }
  if (!changes) throw unprocessable(`タグは${GUEST_TAG_MAX_PER_CASE}個まで作成できます`);
  return { id, name };
}

export async function renameGuestTag(
  db: D1Database,
  user: Actor,
  caseId: string,
  tagId: string,
  name: string,
) {
  await assertEditable(db, user, caseId, 'タグ');
  let changes;
  try {
    changes = (
      await db
        .prepare(`UPDATE case_guest_tags SET name=? WHERE id=? AND case_id=? AND ${editable}`)
        .bind(name, tagId, caseId, caseId, user.id)
        .run()
    ).meta.changes;
  } catch (error) {
    throw duplicateTag(error);
  }
  if (!changes) throw notFound('タグが見つかりません');
  return { id: tagId, name };
}

export async function deleteGuestTag(db: D1Database, user: Actor, caseId: string, tagId: string) {
  await assertEditable(db, user, caseId, 'タグ');
  // ゲストとの対応は外部キーの ON DELETE CASCADE で一緒に消える
  const { changes } = (
    await db
      .prepare(`DELETE FROM case_guest_tags WHERE id=? AND case_id=? AND ${editable}`)
      .bind(tagId, caseId, caseId, user.id)
      .run()
  ).meta;
  if (!changes) throw notFound('タグが見つかりません');
}

/** ゲスト1人の自由タグを指定した内容に置き換える。同じ案件のタグに限る。 */
export async function setGuestTags(
  db: D1Database,
  user: Actor,
  caseId: string,
  guestId: string,
  tagIds: string[],
) {
  await assertEditable(db, user, caseId, 'タグ');
  const guest = await db
    .prepare('SELECT id FROM case_guests WHERE id=? AND case_id=?')
    .bind(guestId, caseId)
    .first();
  if (!guest) throw notFound('ゲストが見つかりません');
  const unique = [...new Set(tagIds)];
  if (unique.length) {
    const found = await db
      .prepare(
        `SELECT count(*) AS n FROM case_guest_tags WHERE case_id=? AND id IN (${unique.map(() => '?').join(',')})`,
      )
      .bind(caseId, ...unique)
      .first<{ n: number }>();
    if (found?.n !== unique.length) throw unprocessable('対象の案件にないタグは付けられません');
  }
  await db.batch([
    db
      .prepare(`DELETE FROM case_guest_tag_links WHERE guest_id=? AND ${editable}`)
      .bind(guestId, caseId, user.id),
    ...unique.map((tagId) =>
      db
        .prepare(
          `INSERT INTO case_guest_tag_links (guest_id,tag_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM case_guest_tags WHERE id=? AND case_id=?) AND ${editable}`,
        )
        .bind(guestId, tagId, tagId, caseId, caseId, user.id),
    ),
  ]);
}
