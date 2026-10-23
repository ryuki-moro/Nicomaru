import type { D1Database } from '@cloudflare/workers-types';
import type { z } from 'zod';
import type { AppUser } from '@/lib/auth/session';
import type { PartnerRole, ContactChannel } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '@/lib/errors';
import { emailHash, encryptPii, normalizeEmail } from '@/lib/crypto';
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  invitationMaxUses,
  buildInvitationUrl,
  invitationState,
} from '@/lib/services/invitations';
import { planTasks, phaseNameFor, type TemplateForAssign } from '@/lib/services/schedule';
import type { caseCreateSchema, initialRegisterSchema } from '@/lib/validation';
import { caseRow, scope } from './cases';

const staffScope = `${scope} AND c.archived_at IS NULL AND EXISTS (SELECT 1 FROM user_profiles w WHERE w.id=? AND w.status='active' AND w.role IN ('planner','admin','system_admin'))`;
const existsCase = `EXISTS (SELECT 1 FROM wedding_cases c WHERE c.id=? AND ${staffScope})`;
const invitationError = () =>
  unprocessable(
    'この招待URLは使用済みか、有効期限が切れています。プランナーへ再発行をご依頼ください',
  );
const tokenResult = (
  id: string,
  partnerRole: PartnerRole,
  channel: ContactChannel,
  expiresAt: string,
  token: string,
) => ({
  id,
  targetPartnerRole: partnerRole,
  channel,
  expiresAt,
  url: buildInvitationUrl(process.env.APP_BASE_URL!, token),
});

export async function createCase(
  db: D1Database,
  user: AppUser,
  input: z.infer<typeof caseCreateSchema>,
) {
  const actor = await db
    .prepare(
      "SELECT venue_id FROM user_profiles WHERE id=? AND role IN ('planner','admin') AND status='active'",
    )
    .bind(user.id)
    .first<{ venue_id: string }>();
  if (!actor?.venue_id) throw forbidden();
  const venue = actor.venue_id;
  if (input.weddingTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.weddingTime))
    throw badRequest([{ field: 'weddingTime', reason: '有効な時刻を指定してください' }]);
  const plan = await db
    .prepare('SELECT id FROM plan_types WHERE id=? AND venue_id=? AND active=1')
    .bind(input.planTypeId, venue)
    .first();
  if (!plan)
    throw badRequest([{ field: 'planTypeId', reason: '所属式場のプランを指定してください' }]);
  const permitted = `EXISTS (SELECT 1 FROM user_profiles a JOIN plan_types p ON p.venue_id=a.venue_id WHERE a.id=? AND a.venue_id=? AND a.status='active' AND a.role IN ('planner','admin') AND p.id=? AND p.active=1)`;
  const args = [user.id, venue, input.planTypeId];
  const id = crypto.randomUUID(),
    year = Number(input.weddingDate.slice(0, 4));
  const now = new Date().toISOString(),
    expiresAt = invitationExpiresAt('initial_registration').toISOString();
  const issued = (['groom', 'bride'] as const).map((role) => ({
    id: crypto.randomUUID(),
    role,
    token: generateInvitationToken(),
  }));
  const exists = 'EXISTS (SELECT 1 FROM wedding_cases WHERE id=?)';
  const statements = [
    db
      .prepare(
        `INSERT INTO case_counters(venue_id,year,value) SELECT ?,?,1 WHERE ${permitted} ON CONFLICT(venue_id,year) DO UPDATE SET value=value+1`,
      )
      .bind(venue, year, ...args),
    db
      .prepare(
        `INSERT INTO wedding_cases(id,venue_id,primary_planner_id,plan_type_id,case_code,wedding_date,wedding_time,contact_channel,guest_count,venue_room,notes)
      SELECT ?,?,?,?,v.code||'-'||printf('%04d',?)||'-'||printf('%04d',n.value),?,?,?,?,?,? FROM venues v JOIN case_counters n ON n.venue_id=v.id
      WHERE v.id=? AND n.year=? AND ${permitted} RETURNING case_code`,
      )
      .bind(
        id,
        venue,
        user.id,
        input.planTypeId,
        year,
        input.weddingDate,
        input.weddingTime ?? null,
        input.contactChannel,
        input.guestCount ?? 0,
        input.venueRoom ?? null,
        input.notes ?? null,
        venue,
        year,
        ...args,
      ),
  ];
  for (const partner of issued) {
    const primary = partner.role === input.primaryContact;
    statements.push(
      db
        .prepare(
          `INSERT INTO couple_profiles(case_id,partner_role,full_name,email,is_primary_contact) SELECT ?,?,?,?,? WHERE ${exists}`,
        )
        .bind(
          id,
          partner.role,
          encryptPii(partner.role === 'groom' ? input.groomName : input.brideName),
          primary ? encryptPii(input.contactEmail) : null,
          primary ? 1 : 0,
          id,
        ),
      db
        .prepare(
          `INSERT INTO case_invitations(id,case_id,target_partner_role,token_hash,recipient_email_hash,channel,expires_at,max_uses,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE ${exists}`,
        )
        .bind(
          partner.id,
          id,
          partner.role,
          hashInvitationToken(partner.token),
          primary ? emailHash(input.contactEmail) : null,
          input.contactChannel,
          expiresAt,
          invitationMaxUses('initial_registration'),
          now,
          id,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO case_audit(case_id,actor_id,action) SELECT ?,?,'case.create' WHERE ${exists}`,
      )
      .bind(id, user.id, id),
  );
  const results = await db.batch(statements);
  const created = results[1].results[0] as { case_code: string } | undefined;
  if (!created) throw conflict();
  return {
    caseId: id,
    caseCode: created.case_code,
    invitations: issued.map((entry) =>
      tokenResult(entry.id, entry.role, input.contactChannel, expiresAt, entry.token),
    ),
  };
}

export async function assignTasks(db: D1Database, user: AppUser, id: string) {
  if (user.role === 'couple') throw forbidden();
  const row = await caseRow(db, user, id);
  if (row.archived_at) throw conflict('アーカイブ済み案件は変更できません');
  const plan = await db
    .prepare('SELECT templates_json FROM plan_types WHERE id=? AND venue_id=? AND active=1')
    .bind(row.plan_type_id, row.venue_id)
    .first<{ templates_json: string }>();
  if (!plan) throw unprocessable('プラン種別が設定されていません');
  const templates: TemplateForAssign[] = JSON.parse(plan.templates_json);
  const planned = planTasks(
    row.wedding_date,
    templates,
    row.case_tasks.map((t) => t.task_template_id).filter((id): id is string => id !== null),
  );
  if (!planned.length) return { added: 0 };
  const results = await db.batch(
    planned.map((task) => {
      const template = templates.find((t) => t.taskTemplateId === task.taskTemplateId)!;
      return db
        .prepare(
          `INSERT INTO case_tasks(id,case_id,task_template_id,title,due_date,due_offset_days,importance,display_order,submission_format,phase_name)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${existsCase} AND EXISTS (SELECT 1 FROM wedding_cases current WHERE current.id=? AND current.version=?)
      ON CONFLICT(case_id,task_template_id) WHERE task_template_id IS NOT NULL DO NOTHING RETURNING id`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          task.taskTemplateId,
          task.title,
          task.dueDate,
          template.dueOffsetDaysOverride ?? template.dueOffsetDays,
          task.importance,
          task.displayOrder,
          task.submissionFormat,
          phaseNameFor(row.wedding_date, task.dueDate),
          id,
          user.id,
          user.id,
          id,
          row.version,
        );
    }),
  );
  return { added: results.reduce((n, r) => n + r.results.length, 0) };
}

interface Invitation {
  id: string;
  case_id: string;
  target_partner_role: PartnerRole;
  channel: ContactChannel;
  purpose: string;
  token_hash: string;
  recipient_email_hash: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  sent_at: string | null;
  created_at: string;
  use_count: number;
  max_uses: number;
}
export async function listInvitations(db: D1Database, user: AppUser, id: string) {
  if (user.role === 'couple') throw forbidden();
  const weddingCase = await caseRow(db, user, id);
  const result = await db
    .prepare(
      `SELECT i.* FROM case_invitations i JOIN wedding_cases c ON c.id=i.case_id WHERE i.case_id=? AND ${scope} ORDER BY i.created_at DESC,i.rowid DESC`,
    )
    .bind(id, user.id)
    .all<Invitation>();
  const latest = new Map<PartnerRole, Invitation>();
  for (const row of result.results)
    if (!latest.has(row.target_partner_role)) latest.set(row.target_partner_role, row);
  return {
    invitations: [...latest.values()].map((row) => ({
      id: row.id,
      targetPartnerRole: row.target_partner_role,
      hasEmail: Boolean(
        weddingCase.couple_profiles.find((p) => p.partner_role === row.target_partner_role)?.email,
      ),
      channel: row.channel,
      state: invitationState(row),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSentAt:
        result.results.find((i) => i.target_partner_role === row.target_partner_role && i.sent_at)
          ?.sent_at ?? null,
    })),
  };
}

export async function issueInvitation(
  db: D1Database,
  user: AppUser,
  id: string,
  role: PartnerRole,
  send?: ContactChannel,
  invitationId?: string,
) {
  if (user.role === 'couple') throw forbidden();
  const row = await caseRow(db, user, id);
  if (row.archived_at) throw conflict('アーカイブ済み案件は変更できません');
  if (invitationId) {
    const existing = await db
      .prepare(
        "SELECT target_partner_role FROM case_invitations WHERE id=? AND case_id=? AND purpose='initial_registration'",
      )
      .bind(invitationId, id)
      .first<{ target_partner_role: PartnerRole }>();
    if (!existing) throw notFound();
    role = existing.target_partner_role;
  }
  const partner = row.couple_profiles.find((p) => p.partner_role === role);
  if (!partner) throw notFound();
  const linked = await db
    .prepare('SELECT user_id FROM couple_profiles WHERE case_id=? AND partner_role=?')
    .bind(id, role)
    .first<{ user_id: string | null }>();
  if (linked?.user_id) throw conflict('この方は登録済みです');
  const token = generateInvitationToken(),
    invitation = crypto.randomUUID(),
    now = new Date().toISOString();
  const expiresAt = invitationExpiresAt('initial_registration').toISOString(),
    channel = send ?? row.contact_channel;
  const args = [id, user.id, user.id, id, role, id, row.version];
  const guard = `${existsCase} AND EXISTS (SELECT 1 FROM couple_profiles cp WHERE cp.case_id=? AND cp.partner_role=? AND cp.user_id IS NULL) AND EXISTS (SELECT 1 FROM wedding_cases current WHERE current.id=? AND current.version=?)`;
  const statements = [
    db
      .prepare(
        `UPDATE case_invitations SET revoked_at=? WHERE case_id=? AND target_partner_role=? AND revoked_at IS NULL AND ${guard}`,
      )
      .bind(now, id, role, ...args),
    db
      .prepare(
        `INSERT INTO case_invitations(id,case_id,target_partner_role,token_hash,recipient_email_hash,channel,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard} RETURNING id`,
      )
      .bind(
        invitation,
        id,
        role,
        hashInvitationToken(token),
        partner.email ? emailHash(partner.email) : null,
        channel,
        expiresAt,
        now,
        ...args,
      ),
    db
      .prepare(
        `INSERT INTO case_audit(case_id,actor_id,action) SELECT ?,?,'invitation.issue' WHERE EXISTS (SELECT 1 FROM case_invitations WHERE id=?)`,
      )
      .bind(id, user.id, invitation),
  ];
  if (send)
    statements.push(
      db
        .prepare(
          `INSERT INTO local_mailbox(id,payload,created_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM case_invitations WHERE id=?)`,
        )
        .bind(
          crypto.randomUUID(),
          encryptPii(
            JSON.stringify({
              kind: 'invitation',
              email: partner.email,
              url: buildInvitationUrl(process.env.APP_BASE_URL!, token),
              channel,
              expiresAt,
            }),
          ),
          now,
          invitation,
        ),
    );
  const results = await db.batch(statements);
  if (!results[1].results.length) throw conflict();
  return {
    ...tokenResult(invitation, role, channel, expiresAt, token),
    sentAt: null,
    delivered: false,
    skippedReason: send ? '外部送信なし。ローカル受信箱に保存した。' : null,
  };
}

interface VerifiedUser {
  id: string;
  email: string;
  emailVerified: boolean;
}
const validInvitation = `i.purpose='initial_registration' AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>? AND i.use_count<i.max_uses AND c.archived_at IS NULL`;
export async function registerCouple(
  db: D1Database,
  input: z.infer<typeof initialRegisterSchema>,
  verified: VerifiedUser | null,
) {
  const email = normalizeEmail(input.email),
    now = new Date().toISOString();
  const invitation = await db
    .prepare(
      `SELECT i.*,c.venue_id FROM case_invitations i JOIN wedding_cases c ON c.id=i.case_id WHERE i.token_hash=? AND ${validInvitation}`,
    )
    .bind(hashInvitationToken(input.token), now)
    .first<Invitation & { venue_id: string }>();
  if (
    !invitation ||
    (invitation.recipient_email_hash && invitation.recipient_email_hash !== emailHash(email))
  )
    throw invitationError();
  const partner = await db
    .prepare('SELECT user_id FROM couple_profiles WHERE case_id=? AND partner_role=?')
    .bind(invitation.case_id, invitation.target_partner_role)
    .first<{ user_id: string | null }>();
  if (!partner || partner.user_id) throw conflict('この方は登録済みです');
  const existing = await db
    .prepare(
      'SELECT u.id,p.role,p.status,p.venue_id,cp.case_id FROM "user" u JOIN user_profiles p ON p.id=u.id LEFT JOIN couple_profiles cp ON cp.user_id=u.id WHERE u.email=?',
    )
    .bind(email)
    .first<{
      id: string;
      role: string;
      status: string;
      venue_id: string;
      case_id: string | null;
    }>();
  if (
    existing &&
    (existing.role !== 'couple' ||
      existing.status !== 'active' ||
      existing.venue_id !== invitation.venue_id ||
      existing.case_id)
  )
    throw conflict('このメールアドレスは別の用途で登録されています');
  if (!existing) {
    const id = crypto.randomUUID();
    const valid = `EXISTS (SELECT 1 FROM case_invitations i JOIN wedding_cases c ON c.id=i.case_id WHERE i.id=? AND ${validInvitation})`;
    const created = await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) SELECT ?,?,?,0,?,? WHERE ${valid} RETURNING id`,
        )
        .bind(id, input.fullName, email, Date.now(), Date.now(), invitation.id, now),
      db
        .prepare(
          `INSERT INTO user_profiles(id,venue_id,role,status) SELECT ?,?,'couple','active' WHERE EXISTS (SELECT 1 FROM "user" WHERE id=?)`,
        )
        .bind(id, invitation.venue_id, id),
    ]);
    if (!created[0].results.length) throw conflict('登録が競合しました。もう一度お試しください');
    return { status: 'verification_required' as const, email };
  }
  if (
    !verified ||
    !verified.emailVerified ||
    verified.id !== existing.id ||
    normalizeEmail(verified.email) !== email
  )
    return { status: 'verification_required' as const, email };
  const claim = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE case_invitations AS i SET used_at=?,use_count=use_count+1,claim_id=? WHERE i.id=? AND
      EXISTS (SELECT 1 FROM wedding_cases c WHERE c.id=i.case_id AND ${validInvitation} AND c.venue_id=?)
      AND (i.recipient_email_hash IS NULL OR i.recipient_email_hash=?)
      AND EXISTS (SELECT 1 FROM user_profiles p JOIN "user" u ON u.id=p.id WHERE p.id=? AND p.role='couple' AND p.status='active' AND p.venue_id=? AND u.email=? AND u.emailVerified=1)
      AND EXISTS (SELECT 1 FROM couple_profiles cp WHERE cp.case_id=i.case_id AND cp.partner_role=i.target_partner_role AND cp.user_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM couple_profiles cp WHERE cp.user_id=?) RETURNING id`,
      )
      .bind(
        now,
        claim,
        invitation.id,
        now,
        invitation.venue_id,
        emailHash(email),
        existing.id,
        invitation.venue_id,
        email,
        existing.id,
      ),
    db
      .prepare(
        `UPDATE couple_profiles SET user_id=?,email=? WHERE case_id=? AND partner_role=? AND user_id IS NULL AND EXISTS (SELECT 1 FROM case_invitations WHERE id=? AND claim_id=?)`,
      )
      .bind(
        existing.id,
        encryptPii(email),
        invitation.case_id,
        invitation.target_partner_role,
        invitation.id,
        claim,
      ),
    db
      .prepare(
        `INSERT INTO case_audit(case_id,actor_id,action) SELECT ?,?,'couple.register' WHERE EXISTS (SELECT 1 FROM case_invitations WHERE id=? AND claim_id=?)`,
      )
      .bind(invitation.case_id, existing.id, invitation.id, claim),
  ]);
  if (!results[0].results.length) throw invitationError();
  return { status: 'registered' as const, sessionEstablished: true, redirectTo: '/mypage' };
}

export async function otpEligible(db: D1Database, email: string) {
  return !!(await db
    .prepare(
      `SELECT u.id FROM "user" u JOIN user_profiles p ON p.id=u.id WHERE u.email=? AND p.role='couple' AND p.status='active'`,
    )
    .bind(normalizeEmail(email))
    .first());
}
