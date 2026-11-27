/**
 * チャットに添付できる項目（やること・ゲスト・席次）の候補一覧。
 * 見える範囲は閲覧者の権限（scope・ゲストと席次は既存の読み込み関数）にそろえる。
 */
import type { AppUser } from '@/lib/auth/session';
import type { D1Database } from '@cloudflare/workers-types';
import { scope } from './cases';
import { loadGuestBook } from './guests';
import { assertCaseAccess, type RefType } from './messages';

const MAX_CANDIDATES = 50;

export interface RefCandidate {
  type: RefType;
  id: string;
  title: string;
  status: string | null;
}

export async function listRefCandidates(
  db: D1Database,
  user: AppUser,
  caseId: string,
  type: RefType,
  query: string,
): Promise<RefCandidate[]> {
  await assertCaseAccess(db, user, caseId);
  const needle = query.toLowerCase();
  const matches = (title: string) => needle === '' || title.toLowerCase().includes(needle);
  let items: RefCandidate[];
  if (type === 'task') {
    const { results } = await db
      .prepare(
        `SELECT t.id,t.title,t.status FROM case_tasks t JOIN wedding_cases c ON c.id=t.case_id
      WHERE t.case_id=? AND ${scope} ORDER BY t.due_date,t.display_order,t.id`,
      )
      .bind(caseId, user.id)
      .all<{ id: string; title: string; status: string }>();
    items = results.map((r) => ({ type, id: r.id, title: r.title, status: r.status }));
  } else if (type === 'guest') {
    const book = await loadGuestBook(db, user, caseId);
    items = book.responses.flatMap((response) =>
      response.people.map((p) => ({ type, id: p.id, title: p.fullName, status: null })),
    );
  } else {
    // 席次は案件に1つ
    items = [{ type, id: caseId, title: '席次表', status: null }];
  }
  return items.filter((item) => matches(item.title)).slice(0, MAX_CANDIDATES);
}
