/**
 * ゲストの出欠回答（共通の回答URL → case_guests）。
 *
 * 回答URLのトークンは初回登録の招待と同じ生成・ハッシュ関数を使う（256bit 乱数、SHA-256 で照合）。
 * 初回登録URLと違い、新郎新婦が配り直せるよう暗号文も保持する
 * （migrations/20261030000100_guest_rsvp.sql）。
 *
 * 一覧・集計はDBの行を復号したあとの値で行う。新郎新婦のマイページと
 * プランナーの案件詳細で同じ数え方にするため、ここに寄せる。
 */
import {
  GUEST_AGE_CATEGORIES,
  type GuestAgeCategory,
  type GuestGender,
  type GuestRelationship,
  type PartnerRole,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import type { SupabaseServerClient } from '@/lib/supabase/server';

export const GUEST_FORM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function buildGuestFormUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/rsvp/${token}`;
}

/** case_guests から一覧に使う列。 */
export const GUEST_RESPONSE_COLUMNS =
  'id, full_name, kana, relationship, allergy_note, invitation_status, response_group_id, ' +
  'is_companion, guest_side, age_category, gender, responded_at, created_at';

export interface GuestRow {
  id: string;
  full_name: string;
  kana: string | null;
  relationship: string | null;
  allergy_note: string | null;
  invitation_status: string;
  response_group_id: string | null;
  is_companion: boolean;
  guest_side: PartnerRole | null;
  age_category: GuestAgeCategory | null;
  gender: GuestGender | null;
  responded_at: string | null;
  created_at: string;
}

export interface GuestPerson {
  id: string;
  fullName: string;
  kana: string;
  ageCategory: GuestAgeCategory | null;
  gender: GuestGender | null;
  allergyNote: string;
}

/** 1回の回答（本人＋同伴者）。 */
export interface GuestResponse {
  id: string;
  attending: boolean;
  guestSide: PartnerRole | null;
  relationship: GuestRelationship | null;
  respondedAt: string;
  people: GuestPerson[];
}

export interface GuestSummary {
  responses: number;
  attendingPeople: number;
  declinedPeople: number;
  byAge: Record<GuestAgeCategory, number>;
  allergyPeople: number;
}

/**
 * 回答単位に束ね、新しい回答を先に並べる。
 * 回答URLを経由せず登録された行（response_group_id が無い）は1人1回答として扱う。
 */
export function groupGuestResponses(rows: GuestRow[]): GuestResponse[] {
  const groups = new Map<string, GuestRow[]>();
  for (const row of rows) {
    const key = row.response_group_id ?? row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([id, members]) => {
      // 本人を先頭に、同伴者は登録順
      const sorted = [...members].sort(
        (a, b) =>
          Number(a.is_companion) - Number(b.is_companion) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      );
      const head = sorted[0];
      return {
        id,
        attending: head.invitation_status === 'reply_yes',
        guestSide: head.guest_side,
        relationship: head.relationship as GuestRelationship | null,
        respondedAt: head.responded_at ?? head.created_at,
        // 氏名・ふりがな・アレルギーは暗号化列（13-1）。読めない値で画面を落とさない
        people: sorted.map((row) => ({
          id: row.id,
          fullName: readPii(row.full_name),
          kana: readPii(row.kana),
          ageCategory: row.age_category,
          gender: row.gender,
          allergyNote: readPii(row.allergy_note),
        })),
      };
    })
    .sort((a, b) => b.respondedAt.localeCompare(a.respondedAt) || a.id.localeCompare(b.id));
}

/**
 * 案件の回答を読み、回答単位にまとめて返す。読めなかった場合は null。
 * 参照範囲は RLS（case_guests_all）が決めるので、呼び出し側の利用者のクライアントを渡す。
 */
export async function loadGuestResponses(
  supabase: SupabaseServerClient,
  caseId: string,
): Promise<GuestResponse[] | null> {
  const { data, error } = await supabase
    .from('case_guests')
    .select(GUEST_RESPONSE_COLUMNS)
    .eq('case_id', caseId);
  if (error) return null;
  return groupGuestResponses((data ?? []) as unknown as GuestRow[]);
}

export function summarizeGuestResponses(responses: GuestResponse[]): GuestSummary {
  const byAge = Object.fromEntries(GUEST_AGE_CATEGORIES.map((c) => [c, 0])) as Record<
    GuestAgeCategory,
    number
  >;
  let attendingPeople = 0;
  let declinedPeople = 0;
  let allergyPeople = 0;
  for (const response of responses) {
    if (!response.attending) {
      declinedPeople += response.people.length;
      continue;
    }
    for (const person of response.people) {
      attendingPeople += 1;
      if (person.ageCategory) byAge[person.ageCategory] += 1;
      if (person.allergyNote) allergyPeople += 1;
    }
  }
  return { responses: responses.length, attendingPeople, declinedPeople, byAge, allergyPeople };
}
