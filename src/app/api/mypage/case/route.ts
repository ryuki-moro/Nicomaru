import { ok, route } from '@/lib/api/route';
import { requireRole } from '@/lib/auth/session';
import { caseRow, listCases } from '@/lib/d1/cases';
import { localDB, usingD1 } from '@/lib/d1/runtime';
import { notFound } from '@/lib/errors';

export const GET = route(async (request: Request) => {
  if (!usingD1()) throw notFound();
  const user = await requireRole('couple');
  const db = await localDB();
  const id =
    new URL(request.url).searchParams.get('caseId') ?? (await listCases(db, user)).items[0]?.id;
  if (!id) throw notFound();
  const row = await caseRow(db, user, id);
  return ok({
    id: row.id,
    caseCode: row.case_code,
    weddingDate: row.wedding_date,
    weddingTime: row.wedding_time,
    partners: row.couple_profiles.map((p) => ({
      partnerRole: p.partner_role,
      fullName: p.full_name,
    })),
    guestCount: row.guest_count,
    venueRoom: row.venue_room,
    planTypeName: row.plan_types?.name ?? null,
  });
});
