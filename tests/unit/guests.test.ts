/**
 * ゲストの出欠回答: 入力検証（API）と、一覧・集計（新郎新婦とプランナーで共用）を検証する。
 */
import { describe, expect, it } from 'vitest';

import {
  buildGuestFormUrl,
  groupGuestResponses,
  summarizeGuestResponses,
  type GuestRow,
} from '@/lib/services/guests';
import { guestResponseSchema, guestReviewSchema } from '@/lib/validation';

const guest = (overrides: Record<string, unknown> = {}) => ({
  fullName: '山田 花子',
  ageCategory: 'adult',
  gender: 'female',
  ...overrides,
});

const base = { attending: true, guestSide: 'bride', relationship: 'friend' };

describe('guestResponseSchema', () => {
  it('本人と同伴者をまとめて受け付ける', () => {
    const parsed = guestResponseSchema.safeParse({
      ...base,
      guests: [guest({ allergyNote: ' えび ' }), guest({ ageCategory: 'infant' })],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.guests[0].allergyNote).toBe('えび');
  });

  it('出欠・新郎新婦側・関係・年齢区分・性別は必須', () => {
    const parsed = guestResponseSchema.safeParse({ guests: [{ fullName: '' }] });
    expect(parsed.success).toBe(false);
    const fields = parsed.error!.issues.map((issue) => issue.path.join('.'));
    expect(fields).toEqual(
      expect.arrayContaining([
        'attending',
        'guestSide',
        'relationship',
        'guests.0.fullName',
        'guests.0.ageCategory',
        'guests.0.gender',
      ]),
    );
  });

  it('欠席の回答に同伴者は付けられない', () => {
    const parsed = guestResponseSchema.safeParse({
      ...base,
      attending: false,
      guests: [guest(), guest()],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0].path).toEqual(['guests']);
  });

  it('身体的なご事情は区分と補足を受け付け、「その他」には内容が要る', () => {
    expect(
      guestResponseSchema.safeParse({
        ...base,
        guests: [guest({ assistanceNeeds: ['mobility', 'wheelchair'] })],
      }).success,
    ).toBe(true);
    const other = guestResponseSchema.safeParse({
      ...base,
      guests: [guest({ assistanceNeeds: ['other'] })],
    });
    expect(other.success).toBe(false);
    expect(other.error!.issues[0].path).toEqual(['guests', 0, 'assistanceNote']);
    expect(
      guestResponseSchema.safeParse({
        ...base,
        guests: [guest({ assistanceNeeds: ['unknown'] })],
      }).success,
    ).toBe(false);
  });

  it('1回の回答は10名まで', () => {
    const parsed = guestResponseSchema.safeParse({
      ...base,
      guests: Array.from({ length: 11 }, () => guest()),
    });
    expect(parsed.success).toBe(false);
  });
});

const row = (overrides: Partial<GuestRow>): GuestRow => ({
  id: 'g1',
  full_name: '本人',
  kana: null,
  relationship: 'friend',
  allergy_note: null,
  invitation_status: 'reply_yes',
  response_group_id: 'r1',
  is_companion: false,
  guest_side: 'bride',
  age_category: 'adult',
  gender: 'female',
  responded_at: '2026-10-01T00:00:00Z',
  created_at: '2026-10-01T00:00:00Z',
  assistance_needs: [],
  assistance_note: null,
  checked_at: null,
  relationship_override: null,
  seat_role: null,
  seat_title: null,
  ...overrides,
});

describe('groupGuestResponses／summarizeGuestResponses', () => {
  const rows: GuestRow[] = [
    row({ id: 'g2', full_name: '同伴', is_companion: true, age_category: 'child' }),
    row({
      id: 'g1',
      allergy_note: 'えび',
      assistance_needs: ['wheelchair', 'mobility'],
      checked_at: '2026-10-03T00:00:00Z',
    }),
    row({
      id: 'g3',
      full_name: '欠席者',
      response_group_id: 'r2',
      invitation_status: 'reply_no',
      responded_at: '2026-10-02T00:00:00Z',
      created_at: '2026-10-02T00:00:00Z',
    }),
  ];

  it('回答単位にまとめ、本人を先頭・新しい回答を先にする', () => {
    const responses = groupGuestResponses(rows);
    expect(responses.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(responses[1].people.map((p) => p.fullName)).toEqual(['本人', '同伴']);
    expect(responses[1].attending).toBe(true);
    expect(responses[0].attending).toBe(false);
    // 区分は保存順ではなく GUEST_ASSISTANCE_NEEDS の順に並べる
    expect(responses[1].people[0].assistanceNeeds).toEqual(['mobility', 'wheelchair']);
  });

  it('出席者だけを年齢区分・アレルギーで数える', () => {
    expect(summarizeGuestResponses(groupGuestResponses(rows))).toEqual({
      responses: 2,
      attendingPeople: 2,
      declinedPeople: 1,
      byAge: { adult: 1, child: 1, infant: 0 },
      allergyPeople: 1,
      assistancePeople: 1,
      pendingPeople: 1,
    });
  });
});

describe('buildGuestFormUrl', () => {
  it('末尾のスラッシュを重ねない', () => {
    expect(buildGuestFormUrl('https://example.test/', 'abc')).toBe('https://example.test/rsvp/abc');
  });
});

describe('ゲスト一覧の確認（#179）', () => {
  it('直したご関係を使い、回答のご関係も残す', () => {
    const [response] = groupGuestResponses([
      row({
        relationship: 'other',
        relationship_override: 'colleague',
        checked_at: '2026-10-03T00:00:00Z',
      }),
    ]);
    const [person] = response.people;
    expect(person.relationship).toBe('colleague');
    expect(person.answeredRelationship).toBe('other');
    expect(person.checked).toBe(true);
  });

  it('肩書きは入力が無ければ新郎新婦側とご関係から作り、同伴の子どもは「ご家族」を付ける', () => {
    const [response] = groupGuestResponses([
      row({ id: 'g1', guest_side: 'groom', relationship: 'colleague' }),
      row({
        id: 'g2',
        is_companion: true,
        age_category: 'child',
        created_at: '2026-10-01T00:00:01Z',
      }),
      row({
        id: 'g3',
        guest_side: 'groom',
        relationship: 'colleague',
        is_companion: true,
        created_at: '2026-10-01T00:00:02Z',
      }),
    ]);
    expect(response.people.map((p) => p.seatTitle)).toEqual([
      '新郎同僚',
      '新郎同僚ご家族',
      '新郎同僚',
    ]);
  });

  it('入力済みの肩書きと役割はそのまま使い、候補も見本として残す', () => {
    const [response] = groupGuestResponses([
      row({
        guest_side: 'groom',
        relationship: 'colleague',
        seat_title: '新郎上司',
        seat_role: 'chief',
      }),
    ]);
    const [person] = response.people;
    expect(person.seatTitle).toBe('新郎上司');
    expect(person.suggestedSeatTitle).toBe('新郎同僚');
    expect(person.seatRole).toBe('chief');
  });
});

describe('guestReviewSchema', () => {
  it('送った項目だけを受け付け、空の変更と知らない項目は拒否する', () => {
    expect(guestReviewSchema.safeParse({ checked: true }).success).toBe(true);
    expect(guestReviewSchema.safeParse({ seatRole: null, seatTitle: null }).success).toBe(true);
    expect(guestReviewSchema.safeParse({}).success).toBe(false);
    expect(guestReviewSchema.safeParse({ fullName: '別人' }).success).toBe(false);
    expect(guestReviewSchema.safeParse({ seatRole: 'mc' }).success).toBe(false);
  });
});
