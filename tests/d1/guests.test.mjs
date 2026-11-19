import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { ids, seedAppFixtures } from '../../scripts/d1-fixtures.mjs';
import { encryptPii, readPii } from '../../src/lib/crypto.ts';
import { patchCase } from '../../src/lib/d1/cases.ts';
import {
  activeGuestFormToken,
  createGuestTag,
  deleteGuestTag,
  loadGuestBook,
  peekGuestForm,
  reissueGuestForm,
  renameGuestTag,
  reviewGuest,
  setGuestTags,
  submitGuestResponse,
} from '../../src/lib/d1/guests.ts';
import { hashInvitationToken } from '../../src/lib/services/invitations.ts';

let platform, db;
const actor = (id) => ({ id });
const coupleA = actor(ids.coupleA),
  plannerA = actor(ids.plannerA),
  plannerB = actor(ids.plannerB),
  adminA = { id: ids.adminA, role: 'admin', venueId: ids.venueA },
  coupleB = actor(ids.coupleB);
const person = (fullName, extra = {}) => ({
  fullName,
  kana: 'ふりがな',
  ageCategory: 'adult',
  gender: 'female',
  allergyNote: '',
  assistanceNeeds: [],
  assistanceNote: '',
  ...extra,
});
const response = (guests, attending = true) => ({
  attending,
  guestSide: 'bride',
  relationship: 'friend',
  guests,
});

before(async () => {
  process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  platform = await getPlatformProxy({ configPath: 'cloudflare/wrangler.jsonc', persist: false });
  db = platform.env.DB;
  for (const file of (await readdir('cloudflare/migrations')).sort()) {
    const sql = await readFile(`cloudflare/migrations/${file}`, 'utf8');
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  await seedAppFixtures(db, encryptPii);
});
after(async () => platform?.dispose());

test('回答URLの発行・切り替え・回答の登録と一覧（暗号化と同伴者の並び）', async () => {
  assert.equal(await activeGuestFormToken(db, coupleA, ids.caseA), null);
  const first = await reissueGuestForm(db, coupleA, ids.caseA);
  const second = await reissueGuestForm(db, plannerA, ids.caseA);
  assert.equal(readPii(await activeGuestFormToken(db, coupleA, ids.caseA)), second);
  // 切り替え前のURLは使えない
  assert.equal(await peekGuestForm(db, hashInvitationToken(first)), null);
  assert.equal(
    await submitGuestResponse(db, hashInvitationToken(first), response([person('旧URL')])),
    false,
  );
  const peek = await peekGuestForm(db, hashInvitationToken(second));
  assert.equal(peek.wedding_date, '2027-06-20');
  assert.equal(readPii(peek.groom_name_enc), 'A-001 太郎');

  const hash = hashInvitationToken(second);
  assert.equal(
    await submitGuestResponse(
      db,
      hash,
      response([
        person('本人', { allergyNote: 'えび', assistanceNeeds: ['mobility', 'mobility'] }),
        person('同伴の子', { ageCategory: 'child' }),
      ]),
    ),
    true,
  );
  assert.equal(
    await submitGuestResponse(db, hash, response([person('欠席者', { allergyNote: '卵' })], false)),
    true,
  );
  const stored = await db.prepare('SELECT * FROM case_guests WHERE is_companion=0').all();
  assert.ok(stored.results.every((row) => row.full_name !== '本人' && row.full_name !== '欠席者'));

  const book = await loadGuestBook(db, plannerA, ids.caseA);
  assert.equal(book.responses.length, 2);
  const attending = book.responses.find((r) => r.attending);
  assert.deepEqual(
    attending.people.map((p) => p.fullName),
    ['本人', '同伴の子'],
  );
  assert.equal(attending.people[0].allergyNote, 'えび');
  assert.deepEqual(attending.people[0].assistanceNeeds, ['mobility']);
  const declined = book.responses.find((r) => !r.attending);
  // 欠席の回答ではアレルギーを保存しない
  assert.equal(declined.people[0].allergyNote, '');
});

test('ゲストの確認・修正は送った項目だけを変え、回答は残る（#179）', async () => {
  const book = await loadGuestBook(db, coupleA, ids.caseA);
  const [head, companion] = book.responses.find((r) => r.attending).people;
  const declined = book.responses.find((r) => !r.attending).people[0];
  // 新しく届いた回答は確認待ち
  assert.equal(head.checked, false);

  await reviewGuest(db, coupleA, ids.caseA, head.id, { checked: true });
  await reviewGuest(db, plannerA, ids.caseA, companion.id, {
    relationship: 'family',
    seatRole: 'chief',
    seatTitle: '  新婦 叔父 ',
  });
  await assert.rejects(reviewGuest(db, coupleA, ids.caseA, declined.id, { checked: true }), {
    status: 422,
  });
  await assert.rejects(reviewGuest(db, plannerB, ids.caseA, head.id, { checked: true }), {
    code: 'NOT_FOUND',
  });
  // パスの案件とゲストの所属が食い違う指定は存在しない扱い
  await assert.rejects(reviewGuest(db, coupleB, ids.caseB, head.id, { checked: true }), {
    code: 'NOT_FOUND',
  });

  let people = (await loadGuestBook(db, coupleA, ids.caseA)).responses.find(
    (r) => r.attending,
  ).people;
  assert.equal(people[0].checked, true);
  assert.equal(people[1].relationship, 'family');
  assert.equal(people[1].answeredRelationship, 'friend');
  assert.equal(people[1].seatRole, 'chief');
  assert.equal(people[1].customSeatTitle, '新婦 叔父');
  const stored = await db
    .prepare('SELECT * FROM case_guests WHERE id=?')
    .bind(companion.id)
    .first();
  assert.equal(stored.relationship, 'friend');
  assert.equal(stored.checked_at, null);

  // 回答と同じご関係に戻すと「直していない」扱い。空の肩書き・null で自動の候補に戻る
  await reviewGuest(db, plannerA, ids.caseA, companion.id, {
    relationship: 'friend',
    seatRole: null,
    seatTitle: '',
  });
  await reviewGuest(db, coupleA, ids.caseA, head.id, { checked: false });
  people = (await loadGuestBook(db, coupleA, ids.caseA)).responses.find((r) => r.attending).people;
  assert.equal(people[0].checked, false);
  assert.equal(
    (await db.prepare('SELECT * FROM case_guests WHERE id=?').bind(companion.id).first())
      .relationship_override,
    null,
  );
  assert.equal(people[1].seatRole, null);
  assert.equal(people[1].customSeatTitle, null);
});

test('他式場・担当外は参照も変更もできず、アーカイブ済みは変更を拒否する', async () => {
  await assert.rejects(loadGuestBook(db, plannerB, ids.caseA), { code: 'NOT_FOUND' });
  await assert.rejects(loadGuestBook(db, coupleB, ids.caseA), { code: 'NOT_FOUND' });
  await assert.rejects(reissueGuestForm(db, coupleB, ids.caseA), { code: 'NOT_FOUND' });
  await assert.rejects(createGuestTag(db, plannerB, ids.caseA, '他式場'), { code: 'NOT_FOUND' });

  const tag = await createGuestTag(db, coupleA, ids.caseA, '大学の友人');
  await assert.rejects(createGuestTag(db, plannerA, ids.caseA, ' 大学の友人 '), { status: 422 });
  const otherCaseTag = await createGuestTag(db, coupleB, ids.caseB, '会社');
  const guest = (await loadGuestBook(db, coupleA, ids.caseA)).responses[0].people[0];
  await assert.rejects(setGuestTags(db, coupleA, ids.caseA, guest.id, [otherCaseTag.id]), {
    status: 422,
  });
  await assert.rejects(setGuestTags(db, coupleA, ids.caseB, guest.id, [otherCaseTag.id]), {
    code: 'NOT_FOUND',
  });
  await setGuestTags(db, coupleA, ids.caseA, guest.id, [tag.id, tag.id]);
  await renameGuestTag(db, plannerA, ids.caseA, tag.id, 'ゼミの友人');
  let book = await loadGuestBook(db, coupleA, ids.caseA);
  assert.deepEqual(book.tags, [{ id: tag.id, name: 'ゼミの友人' }]);
  assert.deepEqual(book.responses.flatMap((r) => r.people).find((p) => p.id === guest.id).tagIds, [
    tag.id,
  ]);

  const keep = await createGuestTag(db, coupleA, ids.caseA, '残すタグ');
  await deleteGuestTag(db, coupleA, ids.caseA, tag.id);
  book = await loadGuestBook(db, coupleA, ids.caseA);
  assert.equal(
    book.responses.flatMap((r) => r.people).find((p) => p.id === guest.id).tagIds.length,
    0,
  );

  await patchCase(db, adminA, ids.caseA, { archived: true });
  // admin はアーカイブ済みも参照できるが、変更はできない。回答URLも使えなくなる
  assert.equal((await loadGuestBook(db, adminA, ids.caseA)).responses.length, 2);
  await assert.rejects(renameGuestTag(db, adminA, ids.caseA, keep.id, '変更'), { status: 422 });
  await assert.rejects(reissueGuestForm(db, adminA, ids.caseA), { status: 422 });
  await assert.rejects(reviewGuest(db, adminA, ids.caseA, guest.id, { seatRole: 'toast' }), {
    status: 422,
  });
  const token = readPii(await activeGuestFormToken(db, adminA, ids.caseA));
  assert.equal(await peekGuestForm(db, hashInvitationToken(token)), null);
  assert.equal(
    await submitGuestResponse(db, hashInvitationToken(token), response([person('締切後')])),
    false,
  );
  await assert.rejects(loadGuestBook(db, coupleA, ids.caseA), { code: 'NOT_FOUND' });
});
