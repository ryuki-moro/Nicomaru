import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { ids, seedAppFixtures } from '../../scripts/d1-fixtures.mjs';
import { encryptPii } from '../../src/lib/crypto.ts';
import {
  loadGuestBook,
  reissueGuestForm,
  reviewGuest,
  submitGuestResponse,
} from '../../src/lib/d1/guests.ts';
import {
  deleteSeatingLayout,
  loadSeatingChart,
  loadSeatingLayouts,
  reviewSeatingChart,
  saveSeatingChart,
  saveSeatingLayout,
  setSeatingLayoutOffered,
  submitSeatingChart,
} from '../../src/lib/d1/seating.ts';
import { hashInvitationToken } from '../../src/lib/services/invitations.ts';

let platform, db;
const actor = (id) => ({ id });
const plannerA = actor(ids.plannerA),
  plannerA2 = actor(ids.plannerA2),
  adminA = actor(ids.adminA),
  coupleA = actor(ids.coupleA),
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
const response = (guests, { attending = true, guestSide = 'bride', relationship = 'friend' } = {}) => ({
  attending,
  guestSide,
  relationship,
  guests,
});

const table = (name, extra = {}) => ({
  name,
  capacity: 8,
  shape: 'round',
  x: 0.3,
  y: 0.5,
  allowedTags: [],
  ...extra,
});

let bride1, bride2, groom1, unchecked1, declined1;
let layoutId, tableBride, tableAny;

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

  // ゲスト: 新婦側・友人2名（本人＋同伴）、新郎側・家族1名、出席だが未確認1名、欠席1名
  const token = await reissueGuestForm(db, coupleA, ids.caseA);
  const hash = hashInvitationToken(token);
  await submitGuestResponse(db, hash, response([person('新婦本人'), person('新婦同伴')]));
  await submitGuestResponse(
    db,
    hash,
    response([person('新郎家族')], { guestSide: 'groom', relationship: 'family' }),
  );
  await submitGuestResponse(db, hash, response([person('未確認の友人')]));
  await submitGuestResponse(db, hash, response([person('欠席者')], { attending: false }));

  const book = await loadGuestBook(db, coupleA, ids.caseA);
  const people = Object.fromEntries(
    book.responses.flatMap((r) => r.people.map((p) => [p.fullName, p])),
  );
  bride1 = people['新婦本人'];
  bride2 = people['新婦同伴'];
  groom1 = people['新郎家族'];
  unchecked1 = people['未確認の友人'];
  declined1 = people['欠席者'];
  for (const p of [bride1, bride2, groom1])
    await reviewGuest(db, coupleA, ids.caseA, p.id, { checked: true });
});

after(async () => platform?.dispose());

test('配置パターンは担当スタッフだけが作れ、卓のIDは保存し直しても変わらない（#180）', async () => {
  // 新郎新婦と、担当でないプランナー（案件自体が見えない）は作れない
  await assert.rejects(
    saveSeatingLayout(db, coupleA, ids.caseA, null, { name: '配置1', hallShape: 'wide', tables: [table('1卓')] }),
    (e) => e.code === 'FORBIDDEN',
  );
  await assert.rejects(
    saveSeatingLayout(db, plannerA2, ids.caseA, null, { name: '配置1', hallShape: 'wide', tables: [table('1卓')] }),
    (e) => e.code === 'NOT_FOUND',
  );
  // この案件にない自由タグを「座れる人」に使えない
  await assert.rejects(
    saveSeatingLayout(db, plannerA, ids.caseA, null, {
      name: '配置1',
      hallShape: 'wide',
      tables: [table('1卓', { allowedTags: ['tag:00000000-0000-4000-8000-000000000099'] })],
    }),
    (e) => e.code === 'UNPROCESSABLE',
  );

  layoutId = await saveSeatingLayout(db, plannerA, ids.caseA, null, {
    name: '円卓ちらし型',
    hallShape: 'wide',
    tables: [
      table('新婦友人卓', { x: 0.7, allowedTags: ['side:bride', 'relationship:friend'] }),
      table('自由卓', { x: 0.3, y: 0.7 }),
    ],
  });
  const layouts = await loadSeatingLayouts(db, plannerA, ids.caseA);
  assert.equal(layouts.length, 1);
  assert.equal(layouts[0].offeredAt, null);
  [tableBride, tableAny] = layouts[0].tables.map((t) => t.id);

  // 卓の ID を保ったまま名前だけ変える
  await saveSeatingLayout(db, plannerA, ids.caseA, layoutId, {
    name: '円卓ちらし型',
    hallShape: 'wide',
    tables: [
      { ...table('新婦友人1卓', { x: 0.7, allowedTags: ['side:bride', 'relationship:friend'] }), id: tableBride },
      { ...table('自由卓', { x: 0.3, y: 0.7 }), id: tableAny },
    ],
  });
  const again = await loadSeatingLayouts(db, plannerA, ids.caseA);
  assert.deepEqual(
    again[0].tables.map((t) => t.id),
    [tableBride, tableAny],
  );
  assert.equal(again[0].tables[0].name, '新婦友人1卓');
});

test('送った配置だけが新郎新婦に見え、削除もできる（#180）', async () => {
  assert.equal((await loadSeatingLayouts(db, coupleA, ids.caseA)).length, 0);
  await setSeatingLayoutOffered(db, adminA, layoutId, true);
  const offered = await loadSeatingLayouts(db, coupleA, ids.caseA);
  assert.equal(offered.length, 1);
  assert.ok(offered[0].offeredAt);

  const extra = await saveSeatingLayout(db, plannerA, ids.caseA, null, {
    name: '消す配置',
    hallShape: 'tall',
    tables: [table('1卓')],
  });
  await deleteSeatingLayout(db, plannerA, extra);
  assert.equal((await loadSeatingLayouts(db, plannerA, ids.caseA)).length, 1);
});

test('席次は新郎新婦だけが保存でき、版・適格・条件・定員をDB側でも確かめる（#181）', async () => {
  const save = (assignments, version = 0, layout = layoutId) =>
    saveSeatingChart(db, coupleA, ids.caseA, { layoutId: layout, version, assignments });
  const pair = (guestId, tableId) => ({ guestId, tableId });

  // プランナーは席次を保存できない
  await assert.rejects(
    saveSeatingChart(db, plannerA, ids.caseA, { layoutId, version: 0, assignments: [] }),
    (e) => e.code === 'FORBIDDEN',
  );
  // 別の案件の新郎新婦はこの案件が見えない
  await assert.rejects(
    saveSeatingChart(db, coupleB, ids.caseA, { layoutId, version: 0, assignments: [] }),
    (e) => e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN',
  );
  // 版が合わない
  await assert.rejects(save([], 5), (e) => e.code === 'CONFLICT');
  // 未確認の出席者と欠席者は入れられない
  await assert.rejects(save([pair(unchecked1.id, tableAny)]), (e) => e.code === 'UNPROCESSABLE');
  await assert.rejects(save([pair(declined1.id, tableAny)]), (e) => e.code === 'UNPROCESSABLE');
  // 新郎家族は新婦友人卓に入れない（卓の条件）
  await assert.rejects(save([pair(groom1.id, tableBride)]), (e) => e.code === 'UNPROCESSABLE');
  // 同じ人を2席に入れられない
  await assert.rejects(
    save([pair(bride1.id, tableAny), pair(bride1.id, tableBride)]),
    (e) => e.code === 'UNPROCESSABLE',
  );

  // 定員: 定員2の小さい配置では3人入らない
  const small = await saveSeatingLayout(db, plannerA, ids.caseA, null, {
    name: '小さい配置',
    hallShape: 'tall',
    tables: [table('小卓', { capacity: 2 })],
  });
  await setSeatingLayoutOffered(db, plannerA, small, true);
  const smallTable = (await loadSeatingLayouts(db, plannerA, ids.caseA)).find((l) => l.id === small)
    .tables[0].id;
  await assert.rejects(
    save(
      [pair(bride1.id, smallTable), pair(bride2.id, smallTable), pair(groom1.id, smallTable)],
      0,
      small,
    ),
    (e) => e.code === 'UNPROCESSABLE',
  );
  await deleteSeatingLayout(db, plannerA, small);

  // 正常な保存。版が 0 → 1 になる
  const v1 = await save([pair(bride1.id, tableBride), pair(bride2.id, tableBride)]);
  assert.equal(v1, 1);
  const chart = await loadSeatingChart(db, coupleA, ids.caseA);
  assert.equal(chart.version, 1);
  assert.equal(chart.status, 'draft');
  assert.deepEqual(chart.seating[tableBride], [bride1.id, bride2.id]);
  // 古い版での再保存は競合
  await assert.rejects(save([pair(bride1.id, tableBride)], 0), (e) => e.code === 'CONFLICT');
});

test('提出は全員の席が決まってから。提出後は変更できず、プランナーへ通知が届く（#181）', async () => {
  // groom1 が未配置のままでは提出できない（現在の版は 1）
  await assert.rejects(submitSeatingChart(db, coupleA, ids.caseA, 1), (e) => e.code === 'UNPROCESSABLE');
  const v2 = await saveSeatingChart(db, coupleA, ids.caseA, {
    layoutId,
    version: 1,
    assignments: [
      { guestId: bride1.id, tableId: tableBride },
      { guestId: bride2.id, tableId: tableBride },
      { guestId: groom1.id, tableId: tableAny },
    ],
  });
  assert.equal(v2, 2);
  const v3 = await submitSeatingChart(db, coupleA, ids.caseA, 2);
  assert.equal(v3, 3);
  const chart = await loadSeatingChart(db, plannerA, ids.caseA);
  assert.equal(chart.status, 'submitted');
  assert.ok(chart.submittedAt);
  // 提出後は保存できない
  await assert.rejects(
    saveSeatingChart(db, coupleA, ids.caseA, { layoutId, version: 3, assignments: [] }),
    (e) => e.code === 'UNPROCESSABLE',
  );
  const notices = await db
    .prepare(`SELECT * FROM notifications WHERE recipient_user_id=? AND title='席次が提出されました'`)
    .bind(ids.plannerA)
    .all();
  assert.equal(notices.results.length, 1);
  assert.equal(notices.results[0].link_path, `/cases/${ids.caseA}`);
});

test('承認で確定し、差し戻すと再び編集でき、どちらも新郎新婦へ通知が届く（#182）', async () => {
  // 新郎新婦は確認できない
  await assert.rejects(
    reviewSeatingChart(db, coupleA, ids.caseA, { decision: 'approved' }),
    (e) => e.code === 'FORBIDDEN',
  );
  const returned = await reviewSeatingChart(db, plannerA, ids.caseA, {
    decision: 'returned',
    feedback: '主賓の席を高砂に近い卓へ移してください',
  });
  assert.equal(returned.status, 'returned');
  let chart = await loadSeatingChart(db, coupleA, ids.caseA);
  assert.equal(chart.feedback, '主賓の席を高砂に近い卓へ移してください');
  const fixNotices = await db
    .prepare(
      `SELECT * FROM notifications WHERE recipient_user_id=? AND notification_type='needs_fix'`,
    )
    .bind(ids.coupleA)
    .all();
  assert.equal(fixNotices.results.length, 1);
  assert.equal(fixNotices.results[0].link_path, '/mypage/seating');

  // 差し戻されたら再び保存・提出できる
  const v = await saveSeatingChart(db, coupleA, ids.caseA, {
    layoutId,
    version: chart.version,
    assignments: [
      { guestId: bride1.id, tableId: tableBride },
      { guestId: bride2.id, tableId: tableBride },
      { guestId: groom1.id, tableId: tableAny },
    ],
  });
  await submitSeatingChart(db, coupleA, ids.caseA, v);
  const approved = await reviewSeatingChart(db, plannerA, ids.caseA, { decision: 'approved' });
  assert.equal(approved.status, 'approved');
  chart = await loadSeatingChart(db, coupleA, ids.caseA);
  assert.equal(chart.status, 'approved');
  // 確定後は保存できない
  await assert.rejects(
    saveSeatingChart(db, coupleA, ids.caseA, {
      layoutId,
      version: chart.version,
      assignments: [],
    }),
    (e) => e.code === 'UNPROCESSABLE',
  );
  const okNotices = await db
    .prepare(`SELECT * FROM notifications WHERE recipient_user_id=? AND title='席次が確定しました'`)
    .bind(ids.coupleA)
    .all();
  assert.equal(okNotices.results.length, 1);
});

test('アーカイブ済みの案件は配置も席次も変更できない', async () => {
  await db
    .prepare('UPDATE wedding_cases SET archived_at=? WHERE id=?')
    .bind(new Date().toISOString(), ids.caseA)
    .run();
  // プランナーと新郎新婦からはアーカイブ済み案件自体が見えなくなる（既存scopeの作法）
  await assert.rejects(
    saveSeatingLayout(db, plannerA, ids.caseA, null, {
      name: '配置2',
      hallShape: 'wide',
      tables: [table('1卓')],
    }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    saveSeatingChart(db, coupleA, ids.caseA, { layoutId, version: 99, assignments: [] }),
    (e) => e.code === 'NOT_FOUND',
  );
  // 管理者は見えるが、変更はアーカイブ済みとして止める
  await assert.rejects(
    saveSeatingLayout(db, adminA, ids.caseA, null, {
      name: '配置2',
      hallShape: 'wide',
      tables: [table('1卓')],
    }),
    (e) => e.code === 'UNPROCESSABLE',
  );
});
