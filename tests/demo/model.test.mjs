import test from 'node:test';
import assert from 'node:assert/strict';
import { seedData, todayJst, STORAGE_KEY } from '../../demo/data.mjs';
import { loadState, validState, transitionTask, saveCase, riskFor, pendingTasks, escapeHtml } from '../../demo/model.mjs';

const now = new Date('2026-10-09T03:00:00Z');
test('initial fictional data and deadlines are valid and follow Japan time', () => {
  const state = seedData(now);
  assert.equal(state.cases.length, 5);
  assert.equal(validState(state), true);
  assert.equal(todayJst(new Date('2026-10-08T15:00:00Z')), '2026-10-09');
  assert.equal(state.cases[0].weddingDate, '2026-11-03');
  assert.equal(riskFor(state.cases[0], '2026-10-09').level, 'high');
  assert.equal(riskFor(state.cases[3], '2026-10-09').level, 'low');
});

test('submit, request correction, resubmit and confirm share state without mutating previous data', () => {
  const initial = seedData(now);
  const submitted = transitionTask(initial, 'demo-01', 'guests', 'submit', 'ご家族10名、ご友人8名です。', now);
  assert.equal(initial.cases[0].tasks[0].status, 'not_started');
  assert.equal(submitted.cases[0].tasks[0].status, 'submitted');
  assert.throws(() => transitionTask(submitted, 'demo-01', 'guests', 'submit', '再提出', now));
  assert.throws(() => transitionTask(submitted, 'demo-01', 'guests', 'return', '  ', now));
  const returned = transitionTask(submitted, 'demo-01', 'guests', 'return', 'お子様の人数を教えてください。', now);
  assert.equal(returned.cases[0].tasks[0].status, 'needs_fix');
  assert.equal(pendingTasks(returned.cases[0]).some(task => task.id === 'guests'), true);
  const resubmitted = transitionTask(returned, 'demo-01', 'guests', 'submit', 'うちお子様は2名です。', now);
  assert.equal(resubmitted.cases[0].tasks[0].feedback, '');
  const confirmed = transitionTask(resubmitted, 'demo-01', 'guests', 'confirm', '', now);
  assert.equal(confirmed.cases[0].tasks[0].status, 'confirmed');
  assert.equal(confirmed.activity.length, 4);
  assert.equal(validState(confirmed), true);
});

test('invalid actions and select answers are rejected', () => {
  const state = seedData(now);
  assert.throws(() => transitionTask(state, 'missing', 'guests', 'submit', '回答', now));
  assert.throws(() => transitionTask(state, 'demo-01', 'guests', 'confirm', '', now));
  assert.throws(() => transitionTask(state, 'demo-01', 'gift', 'submit', '存在しない選択肢', now));
  assert.throws(() => transitionTask(state, 'demo-01', 'guests', 'submit', ' '.repeat(10), now));
  assert.throws(() => transitionTask(state, 'demo-01', 'guests', 'submit', 'A'.repeat(2001), now));
});

test('saved data is validated and malformed or inaccessible storage recovers', () => {
  const good = seedData(now);
  let readKey;
  const loaded = loadState({ getItem(key) { readKey = key; return JSON.stringify(good); } }, now);
  assert.equal(readKey, STORAGE_KEY);
  assert.deepEqual(loaded.state, good);
  for (const raw of ['{broken', 'null', '{"version":999}', JSON.stringify({ ...good, cases: [null] })]) {
    const result = loadState({ getItem: () => raw }, now);
    assert.equal(result.recovered, true);
    assert.equal(result.unavailable, false);
    assert.equal(validState(result.state), true);
  }
  const inaccessible = loadState({ getItem() { throw new Error('blocked'); } }, now);
  assert.equal(inaccessible.unavailable, true);
  assert.equal(validState(inaccessible.state), true);
  const invalid = structuredClone(good);
  invalid.cases[0].tasks[0].status = ['not_started'];
  assert.equal(validState(invalid), false);
  invalid.cases[0].tasks[0].status = 'not_started';
  invalid.cases[0].weddingDate = '2026-02-30';
  assert.equal(validState(invalid), false);
});

test('case creation validates inputs and date edits recalculate deadlines while preserving submissions', () => {
  const initial = seedData(now);
  const fields = { groom: 'サンプル 新郎', bride: 'サンプル 新婦', weddingDate: '2027-01-01', plan: '家族婚', guestCount: 20, notes: '架空の案件' };
  const created = saveCase(initial, fields, null, now);
  assert.equal(initial.cases.length, 5);
  assert.equal(created.state.cases.length, 6);
  assert.equal(created.state.cases.at(-1).code, 'BRIDAL01-0006');
  assert.equal(validState(created.state), true);
  assert.throws(() => saveCase(initial, { ...fields, groom: ' ' }, null, now));
  assert.throws(() => saveCase(initial, { ...fields, guestCount: 1.5 }, null, now));
  assert.throws(() => saveCase(initial, { ...fields, weddingDate: '2026-10-08' }, null, now));
  const original = initial.cases[0];
  const edited = saveCase(initial, { ...original, weddingDate: '2027-01-01' }, original.id, now).state.cases[0];
  assert.equal(edited.tasks.find(task => task.id === 'bgm').status, 'submitted');
  assert.equal(edited.tasks.find(task => task.id === 'bgm').answer, original.tasks.find(task => task.id === 'bgm').answer);
  assert.equal(edited.tasks.find(task => task.id === 'guests').dueDate, '2026-10-03');
});

test('text shown in HTML escapes markup and attribute boundaries', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">\'&'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;');
});
