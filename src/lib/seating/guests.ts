/**
 * 席次に入れる人（#181）。出席の回答で、新郎新婦が確認済みにした人だけが対象になる。
 * 画面で割り振りに使う SeatGuest と、表示に使う名前・肩書きなどを、読み込んだゲストの回答から作る。
 */
import type { GuestAgeCategory, GuestSeatRole, PartnerRole } from '@/lib/constants';
import { guestTags } from '@/lib/guest-tags';
import type { SeatGuest } from '@/lib/seating/assign';
import type { GuestBook } from '@/lib/services/guests';

/** 画面に出す情報 */
export interface SeatGuestInfo {
  id: string;
  name: string;
  /** 席次表に載せる肩書き */
  title: string;
  side: PartnerRole | null;
  ageCategory: GuestAgeCategory | null;
  seatRole: GuestSeatRole | null;
}

export interface SeatGuestList {
  guests: SeatGuest[];
  info: Record<string, SeatGuestInfo>;
}

export function seatGuestsFromBook(book: GuestBook): SeatGuestList {
  const guests: SeatGuest[] = [];
  const info: Record<string, SeatGuestInfo> = {};
  for (const response of book.responses) {
    if (!response.attending) continue;
    for (const person of response.people) {
      if (!person.checked) continue;
      guests.push({
        id: person.id,
        groupId: response.id,
        side: response.guestSide,
        ageCategory: person.ageCategory,
        assistanceNeeds: person.assistanceNeeds,
        seatRole: person.seatRole,
        tagKeys: guestTags(
          {
            guestSide: response.guestSide,
            relationship: person.relationship,
            ageCategory: person.ageCategory,
            allergyNote: person.allergyNote,
            assistanceNeeds: person.assistanceNeeds,
            seatRole: person.seatRole,
            tagIds: person.tagIds,
          },
          book.tags,
        ).map((tag) => tag.key),
      });
      info[person.id] = {
        id: person.id,
        name: person.fullName,
        title: person.seatTitle,
        side: response.guestSide,
        ageCategory: person.ageCategory,
        seatRole: person.seatRole,
      };
    }
  }
  return { guests, info };
}
