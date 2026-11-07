/**
 * ゲスト一覧の確認（席次の前段、#179）で使う、ブラウザーからも呼べる計算。
 *
 * 肩書きは席次表で名前の前に載せるもの（例: 「新郎友人」「新婦恩師」）。
 * 新郎新婦が入力していなければ、新郎新婦側とご関係から候補を作る。
 * 同伴の子どもは、一緒に来た人の肩書きに「ご家族」を付ける（例: 「新郎同僚ご家族」）。
 */
import {
  PARTNER_ROLE_LABEL,
  type GuestAgeCategory,
  type GuestRelationship,
  type PartnerRole,
} from '@/lib/constants';

const RELATIONSHIP_TITLE: Record<GuestRelationship, string> = {
  family: '家族',
  relative: '親族',
  friend: '友人',
  colleague: '同僚',
  teacher: '恩師',
  other: '知人',
};

export interface TitleSource {
  guestSide: PartnerRole | null;
  relationship: GuestRelationship | null;
  ageCategory: GuestAgeCategory | null;
  isCompanion: boolean;
  /** 入力済みの肩書き。null なら候補を使う */
  seatTitle: string | null;
}

/** 肩書きの候補（入力済みの肩書きは見ない）。 */
export function suggestedSeatTitle(guest: TitleSource, head?: TitleSource): string {
  if (guest.isCompanion && head && guest.ageCategory && guest.ageCategory !== 'adult') {
    return `${seatTitleOf(head)}ご家族`;
  }
  const side = guest.guestSide ? PARTNER_ROLE_LABEL[guest.guestSide] : '';
  const relation = guest.relationship ? RELATIONSHIP_TITLE[guest.relationship] : '';
  return side + relation;
}

/** 表示する肩書き。入力済みならそれ、無ければ候補。 */
export function seatTitleOf(guest: TitleSource, head?: TitleSource): string {
  return guest.seatTitle ?? suggestedSeatTitle(guest, head);
}
