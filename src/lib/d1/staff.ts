import type { AppUser } from '@/lib/auth/session';
import {
  INVITE_LINK_TTL_HOURS,
  LIST_PAGE_SIZE,
  ROLE_LABEL,
  type Role,
  type UserStatus,
} from '@/lib/constants';
import { encryptPii, normalizeEmail, readPii } from '@/lib/crypto';
import { conflict, forbidden, notFound, unprocessable } from '@/lib/errors';
import { passwordSetupMessage } from '@/lib/notify/mailer';
import type { userCreateSchema, userUpdateWithActionSchema } from '@/lib/validation';
import type { D1Database } from '@cloudflare/workers-types';
import type { z } from 'zod';
import { createD1Auth, passwordLink } from './auth';
import { deliverMail } from './mailbox';

// 操作者の役割・所属・停止状態は毎回DBの現在値で判定する。t は対象の user_profiles。
const visible = `EXISTS (SELECT 1 FROM user_profiles a WHERE a.id=? AND a.status='active'
  AND t.role IN ('planner','admin') AND (a.role='system_admin' OR (a.role='admin' AND t.venue_id=a.venue_id)))`;
const manageable = `EXISTS (SELECT 1 FROM user_profiles a WHERE a.id=? AND a.status='active' AND (
  (a.role='system_admin' AND t.role IN ('planner','admin'))
  OR (a.role='admin' AND t.role='planner' AND t.venue_id=a.venue_id)))`;
const RESET_PREFIX = 'reset-password:';
const linkExpired = () =>
  unprocessable('このリンクは使用済みか、有効期限が切れています。お手数ですが再度お手続きください');

export interface D1StaffRow {
  id: string;
  display_name: string;
  email: string;
  phone: string | null;
  role: Role;
  venue_id: string | null;
  venue_name: string | null;
  status: UserStatus;
  version: number;
  created_at: string;
}
interface Stored extends Omit<D1StaffRow, 'phone' | 'created_at'> {
  phone: string | null;
  created_at: string | number;
}
const toRow = (row: Stored): D1StaffRow => ({
  ...row,
  phone: row.phone ? readPii(row.phone) : null,
  created_at: new Date(Number(row.created_at) || row.created_at).toISOString(),
});
const select = `SELECT t.id,u.name AS display_name,u.email,t.phone,t.role,t.venue_id,v.name AS venue_name,t.status,t.version,u.createdAt AS created_at
  FROM user_profiles t JOIN "user" u ON u.id=t.id LEFT JOIN venues v ON v.id=t.venue_id`;

export async function listStaff(
  db: D1Database,
  actor: AppUser,
  options: { keyword?: string | null; page?: number },
) {
  const keyword = (options.keyword ?? '').trim().slice(0, 100);
  const like = `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const page = Math.max(options.page ?? 1, 1);
  const result = await db
    .prepare(
      `${select} WHERE ${visible} AND (?='' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
      ORDER BY t.role,u.name,t.id LIMIT ? OFFSET ?`,
    )
    .bind(actor.id, keyword, like, like, LIST_PAGE_SIZE + 1, (page - 1) * LIST_PAGE_SIZE)
    .all<Stored>();
  const rows = result.results.map(toRow);
  return { rows: rows.slice(0, LIST_PAGE_SIZE), hasNext: rows.length > LIST_PAGE_SIZE };
}

export async function listVenues(db: D1Database) {
  return (
    await db
      .prepare('SELECT id,name FROM venues ORDER BY name,id')
      .all<{ id: string; name: string }>()
  ).results;
}

export async function venueName(db: D1Database, venueId: string | null) {
  if (!venueId) return null;
  return (
    (await db.prepare('SELECT name FROM venues WHERE id=?').bind(venueId).first<{ name: string }>())
      ?.name ?? null
  );
}

/** 管理対象でない利用者は存在も明かさず404にする。 */
export async function managedStaff(db: D1Database, actor: AppUser, id: string) {
  const row = await db
    .prepare(`${select} WHERE t.id=? AND ${manageable}`)
    .bind(id, actor.id)
    .first<Stored>();
  if (!row) throw notFound();
  return toRow(row);
}

/** U04 の引き継ぎに必要な担当件数と候補。 */
export async function handoverOptions(db: D1Database, target: D1StaffRow) {
  if (target.role !== 'planner') return { assignedCaseCount: 0, successors: [] };
  const count = await db
    .prepare('SELECT count(*) AS n FROM wedding_cases WHERE primary_planner_id=?')
    .bind(target.id)
    .first<{ n: number }>();
  const successors = (
    await db
      .prepare(
        `SELECT t.id,u.name AS displayName FROM user_profiles t JOIN "user" u ON u.id=t.id
        WHERE t.role='planner' AND t.status='active' AND t.venue_id=? AND t.id<>? ORDER BY u.name,t.id`,
      )
      .bind(target.venue_id, target.id)
      .all<{ id: string; displayName: string }>()
  ).results;
  return { assignedCaseCount: count?.n ?? 0, successors };
}

/** 同じ batch の更新が成立したときだけ記録する。 */
const audit = (
  db: D1Database,
  actorId: string,
  action: string,
  targetId: string,
  detail: object,
  condition: string,
  args: unknown[],
) =>
  db
    .prepare(
      `INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail) SELECT ?,?,'user_profiles',?,? WHERE ${condition}`,
    )
    .bind(actorId, action, targetId, JSON.stringify(detail), ...args);

const revokeLinks = (db: D1Database, userId: string, condition: string, args: unknown[]) =>
  db
    .prepare(
      `DELETE FROM verification WHERE value=? AND identifier LIKE '${RESET_PREFIX}%' AND ${condition}`,
    )
    .bind(userId, ...args);

/** 初回設定リンクを72時間で発行する。形式は better-auth の再設定トークンと同じで、古いリンクは失効させる。 */
async function sendSetupLink(
  db: D1Database,
  target: { id: string; email: string; displayName: string; role: Role; venueId: string | null },
  isResend: boolean,
) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  await revokeLinks(db, target.id, '1', []).run();
  const { internalAdapter } = await createD1Auth(db).$context;
  await internalAdapter.createVerificationValue({
    identifier: `${RESET_PREFIX}${token}`,
    value: target.id,
    expiresAt: new Date(Date.now() + INVITE_LINK_TTL_HOURS * 3600 * 1000),
  });
  const url = passwordLink('invite', token);
  const message = passwordSetupMessage({
    to: target.email,
    displayName: target.displayName,
    roleLabel: ROLE_LABEL[target.role],
    venueName: await venueName(db, target.venueId),
    actionLink: url,
    isResend,
  });
  const sent = await deliverMail(db, { kind: 'password', email: target.email, url, ...message });
  return sent.delivered;
}

export async function createStaff(
  db: D1Database,
  actor: AppUser,
  input: z.infer<typeof userCreateSchema>,
) {
  // 表4-19: 種別と所属は呼び出し元のロールで決め、画面の入力で選ばせない。
  const role: Role = actor.role === 'admin' ? 'planner' : 'admin';
  const venueId = actor.role === 'admin' ? actor.venueId : (input.venueId ?? null);
  const venueField = [{ field: 'venueId', reason: '登録先の式場を指定してください' }];
  if (!venueId) throw unprocessable('所属式場が特定できません', venueField);
  if (!(await venueName(db, venueId))) throw unprocessable('所属式場が特定できません', venueField);
  const email = normalizeEmail(input.email);
  const duplicate = () => db.prepare('SELECT 1 FROM "user" WHERE email=?').bind(email).first();
  if (await duplicate()) throw conflict('このメールアドレスは既に登録されています');
  const id = crypto.randomUUID(),
    now = Date.now();
  const permitted = `EXISTS (SELECT 1 FROM user_profiles a WHERE a.id=? AND a.status='active'
    AND ((a.role='admin' AND a.venue_id=? AND ?='planner') OR (a.role='system_admin' AND ?='admin')))`;
  const created = 'EXISTS (SELECT 1 FROM "user" WHERE id=?)';
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) SELECT ?,?,?,0,?,? WHERE ${permitted} RETURNING id`,
      )
      .bind(id, input.displayName, email, now, now, actor.id, venueId, role, role),
    db
      .prepare(
        `INSERT INTO user_profiles(id,venue_id,role,status,phone) SELECT ?,?,?,'invited',? WHERE ${created}`,
      )
      .bind(id, venueId, role, input.phone ? encryptPii(input.phone) : null, id),
    audit(db, actor.id, 'user.create', id, { role, venue_id: venueId }, created, [id]),
  ]);
  if (!results[0].results.length) {
    if (await duplicate()) throw conflict('このメールアドレスは既に登録されています');
    throw forbidden();
  }
  const mailDelivered = await sendSetupLink(
    db,
    { id, email, displayName: input.displayName, role, venueId },
    false,
  );
  return {
    user: { id, displayName: input.displayName, email, role, status: 'invited' as const },
    mailDelivered,
  };
}

export async function updateStaff(
  db: D1Database,
  actor: AppUser,
  id: string,
  input: z.infer<typeof userUpdateWithActionSchema>,
) {
  const target = await managedStaff(db, actor, id);
  if (target.status === 'deleted') throw notFound();
  const status = input.status ?? target.status;
  // 書き込み前に判定し、途中まで反映してから422を返さない。
  if (input.resendInviteLink && status !== 'invited')
    throw unprocessable(
      '初回パスワード設定リンクを再送できるのは、まだ設定が済んでいない利用者だけです',
    );
  const email = input.email === undefined ? target.email : normalizeEmail(input.email);
  if (
    email !== target.email &&
    (await db.prepare('SELECT 1 FROM "user" WHERE email=? AND id<>?').bind(email, id).first())
  )
    throw conflict('このメールアドレスは既に登録されています');
  const displayName = input.displayName ?? target.display_name;
  const phone = input.phone === undefined ? target.phone : (input.phone ?? null);
  // 読んだ時点の version と一致するときだけ書く。他の操作（停止など）を古い値で上書きしない。
  // batch は1トランザクションなので、version を上げる文を最後に置けば他の文は同じ状態を見る。
  const applied = `EXISTS (SELECT 1 FROM user_profiles t WHERE t.id=? AND t.version=? AND t.status<>'deleted' AND ${manageable})`;
  const appliedArgs = [id, target.version, actor.id];
  const changed = [
    input.displayName !== undefined && displayName !== target.display_name && 'display_name',
    email !== target.email && 'email',
    input.phone !== undefined && phone !== target.phone && 'phone',
    status !== target.status && 'status',
  ].filter(Boolean);
  const statements = [
    db
      .prepare(
        `UPDATE "user" SET name=?,email=?,emailVerified=CASE WHEN email=? THEN emailVerified ELSE 0 END,updatedAt=? WHERE id=? AND ${applied}`,
      )
      .bind(displayName, email, email, Date.now(), id, ...appliedArgs),
    audit(
      db,
      actor.id,
      'user.update',
      id,
      { changed, status, invite_resent: input.resendInviteLink === true },
      applied,
      appliedArgs,
    ),
  ];
  // 停止したら発行済みセッションも即座に失効させる。
  if (status !== 'active')
    statements.push(
      db.prepare(`DELETE FROM session WHERE userId=? AND ${applied}`).bind(id, ...appliedArgs),
    );
  // 宛先変更・停止の後に、旧宛先へ送った設定／再設定リンクを使わせない。
  if (email !== target.email || status === 'suspended')
    statements.push(revokeLinks(db, id, applied, appliedArgs));
  statements.push(
    db
      .prepare(
        `UPDATE user_profiles AS t SET phone=?,status=?,version=version+1
        WHERE t.id=? AND t.version=? AND t.status<>'deleted' AND ${manageable} RETURNING id`,
      )
      .bind(phone ? encryptPii(phone) : null, status, id, target.version, actor.id),
  );
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE'))
      throw conflict('このメールアドレスは既に登録されています');
    throw error;
  }
  if (!results.at(-1)!.results.length) throw conflict();
  const mailDelivered = input.resendInviteLink
    ? await sendSetupLink(
        db,
        { id, email, displayName, role: target.role, venueId: target.venue_id },
        true,
      )
    : null;
  return { id, status, mailDelivered };
}

export async function deleteStaff(
  db: D1Database,
  actor: AppUser,
  id: string,
  successorPlannerId?: string,
) {
  if (id === actor.id) throw unprocessable('ログイン中のご自身のアカウントは削除できません');
  const target = await managedStaff(db, actor, id);
  if (target.status === 'deleted') return;
  const { assignedCaseCount } = await handoverOptions(db, target);
  const field = 'successorPlannerId';
  if (assignedCaseCount > 0) {
    if (!successorPlannerId)
      throw unprocessable('担当している案件があるため、引き継ぎ先のプランナーが必要です', [
        { field, reason: '引き継ぎ先のプランナーを選んでください' },
      ]);
    const usable = await db
      .prepare(
        "SELECT 1 FROM user_profiles WHERE id=? AND id<>? AND role='planner' AND status='active' AND venue_id=?",
      )
      .bind(successorPlannerId, id, target.venue_id)
      .first();
    if (!usable)
      throw unprocessable('引き継ぎ先に指定できない利用者です', [
        { field, reason: '同じ式場の利用中プランナーを選んでください' },
      ]);
  }
  const target_ = `EXISTS (SELECT 1 FROM user_profiles t WHERE t.id=? AND ${manageable})`;
  const successorOk = `EXISTS (SELECT 1 FROM user_profiles s WHERE s.id=? AND s.id<>? AND s.role='planner' AND s.status='active' AND s.venue_id=?)`;
  const deleted = "EXISTS (SELECT 1 FROM user_profiles WHERE id=? AND status='deleted')";
  const statements = [];
  if (successorPlannerId && assignedCaseCount > 0)
    statements.push(
      db
        .prepare(
          `UPDATE wedding_cases SET primary_planner_id=?,version=version+1,updated_at=CURRENT_TIMESTAMP
          WHERE primary_planner_id=? AND ${target_} AND ${successorOk}`,
        )
        .bind(successorPlannerId, id, id, actor.id, successorPlannerId, id, target.venue_id),
    );
  // 担当案件が残っている間は削除しない（並行して案件が割り当てられた場合も含む）。
  const deleteIndex = statements.length;
  statements.push(
    db
      .prepare(
        `UPDATE user_profiles AS t SET status='deleted',version=version+1 WHERE t.id=? AND t.status<>'deleted' AND ${manageable}
        AND NOT EXISTS (SELECT 1 FROM wedding_cases WHERE primary_planner_id=t.id) RETURNING id`,
      )
      .bind(id, actor.id),
    db.prepare(`DELETE FROM session WHERE userId=? AND ${deleted}`).bind(id, id),
    revokeLinks(db, id, deleted, [id]),
    audit(
      db,
      actor.id,
      'user.delete',
      id,
      { role: target.role, venue_id: target.venue_id, handed_over_cases: assignedCaseCount },
      deleted,
      [id],
    ),
  );
  const results = await db.batch(statements);
  if (!results[deleteIndex].results.length) throw conflict();
}

/** P03: パスワード再設定の対象は職員のみ。存否は応答で区別しない。 */
export async function passwordResettable(db: D1Database, email: string) {
  return !!(await db
    .prepare(
      `SELECT 1 FROM "user" u JOIN user_profiles p ON p.id=u.id WHERE u.email=?
      AND p.role IN ('planner','admin','system_admin') AND p.status IN ('active','invited')`,
    )
    .bind(normalizeEmail(email))
    .first());
}

/** 再設定・初回設定の共通着地。初回設定なら利用開始にし、既存セッションは失効させる。 */
export async function completePasswordSetup(db: D1Database, token: string, password: string) {
  const auth = createD1Auth(db);
  const { internalAdapter } = await auth.$context;
  const verification = await internalAdapter.findVerificationValue(`${RESET_PREFIX}${token}`);
  if (!verification || verification.expiresAt < new Date()) throw linkExpired();
  const userId = verification.value;
  const profile = await db
    .prepare('SELECT role,status FROM user_profiles WHERE id=?')
    .bind(userId)
    .first<{ role: Role; status: UserStatus }>();
  if (!profile || profile.role === 'couple' || !['active', 'invited'].includes(profile.status))
    throw linkExpired();
  await auth.api.resetPassword({ body: { newPassword: password, token } }).catch(() => {
    throw linkExpired();
  });
  await db.batch([
    db
      .prepare(
        "UPDATE user_profiles SET status='active',version=version+1 WHERE id=? AND status='invited'",
      )
      .bind(userId),
    db.prepare('UPDATE "user" SET emailVerified=1 WHERE id=?').bind(userId),
    db
      .prepare(
        "INSERT INTO audit_logs(actor_id,action,target_type,target_id) VALUES (?,'password.change','user_profiles',?)",
      )
      .bind(userId, userId),
  ]);
}
