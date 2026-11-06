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
  GUEST_ASSISTANCE_NEEDS,
  type GuestAgeCategory,
  type GuestAssistanceNeed,
  type GuestGender,
  type GuestRelationship,
  type GuestSeatRole,
  type PartnerRole,
} from '@/lib/constants';
import { readPii } from '@/lib/crypto';
import { seatTitleOf, suggestedSeatTitle, type TitleSource } from '@/lib/guest-review';
import type { GuestCustomTag } from '@/lib/guest-tags';

export const GUEST_FORM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function buildGuestFormUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/rsvp/${token}`;
}

/** case_guests から一覧に使う列。 */
export const GUEST_RESPONSE_COLUMNS =
  'id, full_name, kana, relationship, allergy_note, invitation_status, response_group_id, ' +
  'is_companion, guest_side, age_category, gender, responded_at, created_at, ' +
  'assistance_needs, assistance_note, checked_at, relationship_override, seat_role, seat_title';

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
  assistance_needs: GuestAssistanceNeed[] | null;
  assistance_note: string | null;
  checked_at: string | null;
  relationship_override: string | null;
  seat_role: GuestSeatRole | null;
  seat_title: string | null;
  /** 自由タグの対応（埋め込み select）。読まない場合は省略される */
  case_guest_tag_links?: { tag_id: string }[];
}

export interface GuestPerson {
  id: string;
  fullName: string;
  kana: string;
  ageCategory: GuestAgeCategory | null;
  gender: GuestGender | null;
  allergyNote: string;
  /** 身体的なご事情の区分（足腰・車いすなど）。並びは GUEST_ASSISTANCE_NEEDS の順 */
  assistanceNeeds: GuestAssistanceNeed[];
  assistanceNote: string;
  /** 付いている自由タグのID（case_guest_tags.id） */
  tagIds: string[];
  /** 席次に使うご関係（新郎新婦が直していればその値、無ければ回答の値） */
  relationship: GuestRelationship | null;
  /** 新郎新婦が直す前の、回答のご関係 */
  answeredRelationship: GuestRelationship | null;
  /** 新郎新婦が確認済みにしたか。席次に入るのは出席かつ確認済みの人（#179） */
  checked: boolean;
  seatRole: GuestSeatRole | null;
  /** 入力済みの肩書き。null なら seatTitle は候補 */
  customSeatTitle: string | null;
  /** 表示する肩書き（入力済みの値か、新郎新婦側・ご関係からの候補） */
  seatTitle: string;
  /** 新郎新婦側・ご関係からの肩書きの候補。編集欄の見本に出す */
  suggestedSeatTitle: string;
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
  /** 身体的なご事情（区分または補足）のある出席者 */
  assistancePeople: number;
  /** 出席のうち、新郎新婦がまだ確認済みにしていない人 */
  pendingPeople: number;
}

/** 新郎新婦が直したご関係があればそれを、無ければ回答の値を使う。 */
const effectiveRelationship = (row: GuestRow) =>
  (row.relationship_override ?? row.relationship) as GuestRelationship | null;

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
      const titleSource = (row: GuestRow): TitleSource => ({
        guestSide: head.guest_side,
        relationship: effectiveRelationship(row),
        ageCategory: row.age_category,
        isCompanion: row.is_companion,
        seatTitle: row.seat_title,
      });
      return {
        id,
        attending: head.invitation_status === 'reply_yes',
        guestSide: head.guest_side,
        relationship: head.relationship as GuestRelationship | null,
        respondedAt: head.responded_at ?? head.created_at,
        // 氏名・ふりがな・アレルギー・ご事情の補足は暗号化列（13-1）。読めない値で画面を落とさない
        people: sorted.map((row) => ({
          id: row.id,
          fullName: readPii(row.full_name),
          kana: readPii(row.kana),
          ageCategory: row.age_category,
          gender: row.gender,
          allergyNote: readPii(row.allergy_note),
          assistanceNeeds: GUEST_ASSISTANCE_NEEDS.filter((need) =>
            (row.assistance_needs ?? []).includes(need),
          ),
          assistanceNote: readPii(row.assistance_note),
          tagIds: (row.case_guest_tag_links ?? []).map((link) => link.tag_id),
          relationship: effectiveRelationship(row),
          answeredRelationship: row.relationship as GuestRelationship | null,
          checked: row.checked_at !== null,
          seatRole: row.seat_role,
          customSeatTitle: row.seat_title,
          seatTitle: seatTitleOf(titleSource(row), titleSource(head)),
          suggestedSeatTitle: suggestedSeatTitle(titleSource(row), titleSource(head)),
        })),
      };
    })
    .sort((a, b) => b.respondedAt.localeCompare(a.respondedAt) || a.id.localeCompare(b.id));
}

export interface GuestBook {
  responses: GuestResponse[];
  /** 案件の自由タグ（作成順）。絞り込みと付け外しの候補になる */
  tags: GuestCustomTag[];
}

export function summarizeGuestResponses(responses: GuestResponse[]): GuestSummary {
  const byAge = Object.fromEntries(GUEST_AGE_CATEGORIES.map((c) => [c, 0])) as Record<
    GuestAgeCategory,
    number
  >;
  let attendingPeople = 0;
  let declinedPeople = 0;
  let allergyPeople = 0;
  let assistancePeople = 0;
  let pendingPeople = 0;
  for (const response of responses) {
    if (!response.attending) {
      declinedPeople += response.people.length;
      continue;
    }
    for (const person of response.people) {
      attendingPeople += 1;
      if (person.ageCategory) byAge[person.ageCategory] += 1;
      if (person.allergyNote) allergyPeople += 1;
      if (person.assistanceNeeds.length > 0 || person.assistanceNote) assistancePeople += 1;
      if (!person.checked) pendingPeople += 1;
    }
  }
  return {
    responses: responses.length,
    attendingPeople,
    declinedPeople,
    byAge,
    allergyPeople,
    assistancePeople,
    pendingPeople,
  };
}
