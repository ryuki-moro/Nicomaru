import {
  VERSION,
  PLANS,
  STATUS_LABELS,
  STORAGE_KEY,
  defaultTasks,
  seedData,
  todayJst,
} from './data.mjs';

const text = (value, max) => typeof value === 'string' && value.length <= max;
const identifier = (value) => text(value, 80) && /^[a-zA-Z0-9_-]+$/.test(value);
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validState(state) {
  if (
    !state ||
    state.version !== VERSION ||
    !Array.isArray(state.cases) ||
    state.cases.length < 1 ||
    state.cases.length > 100 ||
    !Array.isArray(state.activity) ||
    state.activity.length > 50
  )
    return false;
  const ids = new Set();
  for (const item of state.cases) {
    if (
      !item ||
      !identifier(item.id) ||
      ids.has(item.id) ||
      !text(item.code, 80) ||
      !text(item.groom, 80) ||
      !item.groom.trim() ||
      !text(item.bride, 80) ||
      !item.bride.trim() ||
      !isDate(item.weddingDate) ||
      !PLANS.includes(item.plan) ||
      !Number.isInteger(item.guestCount) ||
      item.guestCount < 1 ||
      item.guestCount > 1000 ||
      !text(item.notes, 2000) ||
      !Array.isArray(item.tasks) ||
      item.tasks.length > 32
    )
      return false;
    ids.add(item.id);
    const taskIds = new Set();
    for (const task of item.tasks) {
      if (
        !task ||
        !identifier(task.id) ||
        taskIds.has(task.id) ||
        !text(task.title, 120) ||
        !text(task.description, 1000) ||
        !['text', 'select'].includes(task.type) ||
        typeof task.important !== 'boolean' ||
        !isDate(task.dueDate) ||
        typeof task.status !== 'string' ||
        !Object.hasOwn(STATUS_LABELS, task.status) ||
        !text(task.answer, 2000) ||
        !text(task.feedback, 1000)
      )
        return false;
      if (
        task.type === 'select' &&
        (!Array.isArray(task.options) ||
          task.options.length < 1 ||
          task.options.length > 20 ||
          !task.options.every((option) => text(option, 100)))
      )
        return false;
      taskIds.add(task.id);
    }
  }
  return state.activity.every((item) => item && text(item.message, 200) && text(item.time, 40));
}

export function loadState(storage, now = new Date()) {
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { state: seedData(now), recovered: false, unavailable: true };
  }
  if (!raw) return { state: seedData(now), recovered: false, unavailable: false };
  try {
    const state = JSON.parse(raw);
    if (validState(state)) return { state, recovered: false, unavailable: false };
    return { state: seedData(now), recovered: true, unavailable: false };
  } catch {
    return { state: seedData(now), recovered: true, unavailable: false };
  }
}

export const pendingTasks = (item) =>
  item.tasks.filter((task) => ['not_started', 'needs_fix'].includes(task.status));
export const completedPercent = (item) =>
  item.tasks.length
    ? Math.round(
        (item.tasks.filter((task) => task.status === 'confirmed').length / item.tasks.length) * 100,
      )
    : 0;
export const daysUntil = (date, today = todayJst()) =>
  Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);

export function riskFor(item, today = todayJst()) {
  const pending = pendingTasks(item);
  const overdue = pending.filter((task) => task.dueDate < today);
  const fixes = pending.filter((task) => task.status === 'needs_fix');
  const reasons = [];
  if (overdue.length) reasons.push(`期限を過ぎた宿題が${overdue.length}件あります`);
  if (fixes.length) reasons.push(`修正が必要な宿題が${fixes.length}件あります`);
  const level = overdue.some((task) => task.important)
    ? 'high'
    : overdue.length || fixes.length
      ? 'medium'
      : 'low';
  return {
    level,
    label: { high: '要フォロー', medium: '確認したい', low: '順調' }[level],
    reasons,
  };
}

function findTask(state, caseId, taskId) {
  const item = state.cases.find((entry) => entry.id === caseId);
  const task = item?.tasks.find((entry) => entry.id === taskId);
  if (!item || !task) throw new Error('宿題が見つかりません。');
  return { item, task };
}

function record(state, message, now) {
  state.activity.unshift({ message, time: now.toISOString() });
  state.activity = state.activity.slice(0, 50);
}

export function transitionTask(state, caseId, taskId, action, value = '', now = new Date()) {
  const next = structuredClone(state);
  const { item, task } = findTask(next, caseId, taskId);
  const answer = String(value).trim();
  if (action === 'submit') {
    if (!['not_started', 'needs_fix'].includes(task.status))
      throw new Error('この宿題はすでに提出されています。');
    if (!answer || answer.length > 2000) throw new Error('回答を1〜2000文字で入力してください。');
    if (task.type === 'select' && !task.options.includes(answer))
      throw new Error('選択肢からお選びください。');
    task.answer = answer;
    task.status = 'submitted';
    task.feedback = '';
    record(next, `${item.code}「${task.title}」を提出しました`, now);
  } else if (action === 'confirm') {
    if (task.status !== 'submitted') throw new Error('確認待ちの宿題だけ確認できます。');
    task.status = 'confirmed';
    task.feedback = '';
    record(next, `${item.code}「${task.title}」を確認しました`, now);
  } else if (action === 'return') {
    if (task.status !== 'submitted') throw new Error('確認待ちの宿題だけ差し戻せます。');
    if (!answer || answer.length > 1000)
      throw new Error('修正してほしい内容を1〜1000文字で入力してください。');
    task.status = 'needs_fix';
    task.feedback = answer;
    record(next, `${item.code}「${task.title}」を差し戻しました`, now);
  } else throw new Error('操作が正しくありません。');
  return next;
}

function caseFields(fields, now) {
  const groom = String(fields.groom ?? '').trim();
  const bride = String(fields.bride ?? '').trim();
  const notes = String(fields.notes ?? '').trim();
  const guestCount = Number(fields.guestCount);
  if (!groom || !bride || groom.length > 80 || bride.length > 80)
    throw new Error('新郎・新婦のお名前を80文字以内で入力してください。');
  if (!isDate(fields.weddingDate) || fields.weddingDate < todayJst(now))
    throw new Error('挙式日は今日以降の日付を選んでください。');
  if (!PLANS.includes(fields.plan)) throw new Error('プランをお選びください。');
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 1000)
    throw new Error('ゲスト数は1〜1000人で入力してください。');
  if (notes.length > 2000) throw new Error('メモは2000文字以内で入力してください。');
  return { groom, bride, weddingDate: fields.weddingDate, plan: fields.plan, guestCount, notes };
}

export function saveCase(state, fields, caseId = null, now = new Date()) {
  const values = caseFields(fields, now);
  const next = structuredClone(state);
  if (caseId) {
    const item = next.cases.find((entry) => entry.id === caseId);
    if (!item) throw new Error('案件が見つかりません。');
    const defaults = defaultTasks(values.weddingDate);
    if (item.weddingDate !== values.weddingDate) {
      for (const task of item.tasks)
        task.dueDate = defaults.find((entry) => entry.id === task.id)?.dueDate ?? task.dueDate;
    }
    Object.assign(item, values);
    record(next, `${item.code} の案件情報を更新しました`, now);
  } else {
    if (next.cases.length >= 100) throw new Error('デモでは案件を100件まで登録できます。');
    const number =
      Math.max(0, ...next.cases.map((item) => Number(item.code.split('-').at(-1)) || 0)) + 1;
    const item = {
      id: `demo-${crypto.randomUUID()}`,
      code: `BRIDAL01-${String(number).padStart(4, '0')}`,
      ...values,
      tasks: defaultTasks(values.weddingDate),
    };
    next.cases.push(item);
    record(next, `${item.code} の案件を登録しました`, now);
    caseId = item.id;
  }
  return { state: next, caseId };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}
