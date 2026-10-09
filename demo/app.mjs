import { PLANS, STATUS_LABELS, STORAGE_KEY, seedData, todayJst, shiftDate } from './data.mjs';
import { loadState, pendingTasks, completedPercent, daysUntil, riskFor, transitionTask, saveCase, escapeHtml } from './model.mjs';

const app = document.getElementById('app');
const notice = document.getElementById('notice');
const memoryStorage = { getItem: () => null };
let storage;
try { storage = window.localStorage; } catch { storage = memoryStorage; }
const loaded = loadState(storage);
let state = loaded.state;
let role = 'planner';
let selectedId = state.cases[0].id;
let modal = null;
let returnFocus = null;
let noticeTimer;
const filters = { query: '', risk: 'all', task: 'all' };
const e = escapeHtml;
const dateLabel = value => new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
const coupleName = item => `${item.groom}・${item.bride}`;
const caseFor = id => state.cases.find(item => item.id === id);
const button = (label, action, extra = '', style = 'secondary') => `<button type="button" class="button ${style}" data-action="${action}" ${extra}>${label}</button>`;
const caseAttrs = item => `data-case="${e(item.id)}"`;
const taskAttrs = (item, task) => `${caseAttrs(item)} data-task="${e(task.id)}"`;
const badge = task => `<span class="badge ${{ not_started: 'neutral', submitted: 'warning', needs_fix: 'danger', confirmed: 'success' }[task.status]}">${STATUS_LABELS[task.status]}</span>`;
const riskBadge = item => { const risk = riskFor(item); return `<span class="badge ${{ high: 'danger', medium: 'warning', low: 'success' }[risk.level]}">${risk.label}</span>`; };
const progress = item => `<div class="progress-track" role="progressbar" aria-label="${e(coupleName(item))}の確認済の割合" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${completedPercent(item)}"><div class="progress-fill" style="width:${completedPercent(item)}%"></div></div>`;

function showNotice(message) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 6000);
}

function persist(next) {
  state = next;
  try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { showNotice('ブラウザに保存できませんでした。この画面を開いている間は操作を続けられます。'); return false; }
  return true;
}

function route() {
  const [page = 'dashboard', id] = location.hash.slice(1).split('/');
  if (id && caseFor(id)) selectedId = id;
  if (['mypage', 'tasks', 'timeline'].includes(page)) role = 'couple';
  if (['dashboard', 'cases', 'case', 'prep'].includes(page)) role = 'planner';
  return { page: page || 'dashboard', id };
}

function heading(title, subtitle = '', actions = '') {
  return `<div class="page-heading"><div><p class="eyebrow">${role === 'planner' ? 'プランナー' : '新郎新婦'}</p><h1 tabindex="-1">${title}</h1>${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
}

function navLink(href, label, active) {
  return `<a class="nav-link${active ? ' active' : ''}" href="#${href}" ${active ? 'aria-current="page"' : ''}>${label}</a>`;
}

function render(focusMain = false) {
  const current = route();
  let page;
  const item = caseFor(current.id || selectedId);
  if (current.id && !caseFor(current.id)) page = `${heading('案件が見つかりません')}<div class="empty-state"><p>案件一覧からお選びください。</p><a class="button primary" href="#cases">案件一覧へ</a></div>`;
  else if (current.page === 'dashboard') page = dashboard();
  else if (current.page === 'cases') page = casesPage();
  else if (current.page === 'case') page = detailPage(item);
  else if (current.page === 'prep') page = prepPage(item);
  else if (current.page === 'mypage') page = coupleHome(item);
  else if (current.page === 'tasks') page = coupleTasks(item);
  else if (current.page === 'timeline') page = timelinePage(item);
  else page = `${heading('画面が見つかりません')}<a class="button primary" href="#dashboard">ダッシュボードへ</a>`;

  const navigation = role === 'planner'
    ? navLink('dashboard', 'ダッシュボード', current.page === 'dashboard') + navLink('cases', '案件一覧', ['cases', 'case', 'prep'].includes(current.page))
    : navLink(`mypage/${selectedId}`, 'ホーム', current.page === 'mypage') + navLink(`tasks/${selectedId}`, '宿題', current.page === 'tasks') + navLink(`timeline/${selectedId}`, 'タイムライン', current.page === 'timeline');
  app.innerHTML = `<header class="app-header"><div class="container header-inner">
    <a class="brand" href="#${role === 'planner' ? 'dashboard' : `mypage/${selectedId}`}" aria-label="にこまる ホーム"><span class="brand-mark" aria-hidden="true">n</span>にこまる</a>
    <div class="header-actions"><div class="role-switch" role="group" aria-label="デモの表示切替">
      <button type="button" data-action="role" data-role="planner" class="${role === 'planner' ? 'active' : ''}" aria-pressed="${role === 'planner'}">プランナー</button>
      <button type="button" data-action="role" data-role="couple" class="${role === 'couple' ? 'active' : ''}" aria-pressed="${role === 'couple'}">新郎新婦</button>
    </div>${button('デモを初期化', 'reset', '', 'secondary small')}</div></div></header>
    <div class="container"><div class="demo-banner"><strong>ログイン不要デモ</strong><span>架空のデータで操作を試せます。変更はこのブラウザだけに保存されます。</span></div>
    <div class="layout"><aside class="sidebar no-print"><nav aria-label="メニュー">${navigation}</nav>${role === 'couple' ? `<label class="field-label" for="couple-case">表示するカップル</label><select class="field" id="couple-case">${state.cases.map(entry => `<option value="${e(entry.id)}" ${entry.id === selectedId ? 'selected' : ''}>${e(coupleName(entry))}</option>`).join('')}</select>` : `<p class="muted">プランナー / 佐藤 花子<br>サンプル式場 BRIDAL01</p>`}</aside>
    <main id="main-content" tabindex="-1">${page}</main></div></div>${modal ? renderModal() : ''}`;
  if (modal) app.querySelector('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] select, [role="dialog"] button')?.focus();
  else if (focusMain) document.getElementById('main-content').focus();
}

function dashboard() {
  const pending = state.cases.reduce((sum, item) => sum + pendingTasks(item).length, 0);
  const high = state.cases.filter(item => riskFor(item).level === 'high').length;
  const submitted = state.cases.reduce((sum, item) => sum + item.tasks.filter(task => task.status === 'submitted').length, 0);
  const follow = state.cases.filter(item => riskFor(item).level !== 'low').sort((a, b) => ({ high: 2, medium: 1, low: 0 }[riskFor(b).level] - { high: 2, medium: 1, low: 0 }[riskFor(a).level]) || a.weddingDate.localeCompare(b.weddingDate));
  return `${heading('ダッシュボード', '佐藤 花子さんの担当状況です。', button('案件を登録', 'new-case', '', 'primary'))}
    <section class="summary-grid" aria-label="担当状況">${[[state.cases.length, '担当案件数'], [pending, '未提出の宿題'], [high, '要フォローの案件']].map(([value, label]) => `<div class="stat-card"><span class="muted">${label}</span><p class="stat-value">${value}<small>件</small></p></div>`).join('')}</section>
    <section class="section-gap"><div class="card-header"><h2>今日フォローすべきカップル</h2><span class="muted">確認待ちの提出 ${submitted}件</span></div><div class="follow-grid">${follow.length ? follow.map(item => `<a class="card follow-card" href="#case/${e(item.id)}"><div class="card-header"><strong class="case-name">${e(coupleName(item))}</strong>${riskBadge(item)}</div><p class="meta">${e(item.code)} / ${dateLabel(item.weddingDate)}</p><ul class="reason-list">${riskFor(item).reasons.map(reason => `<li>${reason}</li>`).join('')}</ul></a>`).join('') : '<div class="empty-state">いま気にかけたい案件はありません。</div>'}</div></section>
    <section class="section-gap card"><h2>デモの試し方</h2><ol class="reason-list"><li>「案件一覧」から気になる案件を開きます。</li><li>「新郎新婦の画面で見る」で宿題を提出します。</li><li>「プランナー」に切り替えて、提出内容を確認します。</li></ol><a class="button primary" href="#cases">案件一覧を見る</a></section>
    ${state.activity.length ? `<section class="section-gap card"><h2>最近の操作</h2><ul class="reason-list">${state.activity.slice(0, 5).map(entry => `<li>${e(entry.message)}</li>`).join('')}</ul></section>` : ''}`;
}

function filteredCases() {
  const query = filters.query.trim().toLocaleLowerCase('ja-JP');
  return state.cases.filter(item => `${coupleName(item)} ${item.code}`.toLocaleLowerCase('ja-JP').includes(query)
    && (filters.risk === 'all' || riskFor(item).level === filters.risk));
}

function casesResults() {
  const items = filteredCases();
  if (!items.length) return '<div class="empty-state"><h2>該当する案件はありません</h2><p>検索する名前や条件を変えてお試しください。</p></div>';
  return `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">案件・カップル</th><th scope="col">挙式日 / プラン</th><th scope="col">確認済の割合</th><th scope="col">未提出</th><th scope="col">状況</th></tr></thead><tbody>${items.map(item => `<tr><td><a class="case-link" href="#case/${e(item.id)}">${e(coupleName(item))}</a><p class="meta">${e(item.code)}</p></td><td>${dateLabel(item.weddingDate)}<p class="meta">${e(item.plan)} / ${item.guestCount}名</p></td><td>${progress(item)}<span class="meta">${completedPercent(item)}%</span></td><td>${pendingTasks(item).length}件</td><td>${riskBadge(item)}</td></tr>`).join('')}</tbody></table></div>`;
}

function casesPage() {
  return `${heading('案件一覧', '担当しているカップルの準備状況を確認します。', button('案件を登録', 'new-case', '', 'primary'))}
    <div class="toolbar"><div class="search"><label class="field-label" for="case-search">名前・案件番号で検索</label><input id="case-search" class="field" type="search" placeholder="青木、BRIDAL01 など" value="${e(filters.query)}"></div><div><label class="field-label" for="risk-filter">状況</label><select id="risk-filter" class="field">${[['all', 'すべて'], ['high', '要フォロー'], ['medium', '確認したい'], ['low', '順調']].map(([value, label]) => `<option value="${value}" ${value === filters.risk ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div>
    <p id="results-count" class="meta" aria-live="polite">${filteredCases().length}件の案件</p><div id="cases-results">${casesResults()}</div>`;
}

function caseInfo(item) {
  return `<dl class="detail-list"><div><dt>案件番号</dt><dd>${e(item.code)}</dd></div><div><dt>新郎・新婦</dt><dd>${e(coupleName(item))}</dd></div><div><dt>挙式日</dt><dd>${dateLabel(item.weddingDate)}</dd></div><div><dt>プラン</dt><dd>${e(item.plan)}</dd></div><div><dt>ゲスト数</dt><dd>${item.guestCount}名</dd></div></dl>`;
}

function detailPage(item) {
  return `<p class="meta"><a href="#cases">案件一覧</a> / ${e(item.code)}</p>${heading(e(coupleName(item)), `${dateLabel(item.weddingDate)} / ${e(item.plan)}`, button('案件情報を変更', 'edit-case', caseAttrs(item)))}
    <div class="detail-grid"><section class="card"><h2>案件情報</h2>${caseInfo(item)}<h3>打ち合わせメモ</h3><p class="task-body">${e(item.notes) || 'メモはありません。'}</p></section><section class="card stack"><div class="card-header"><h2>準備の状況</h2>${riskBadge(item)}</div>${progress(item)}<p>確認済 ${item.tasks.filter(task => task.status === 'confirmed').length} / ${item.tasks.length}件</p><ul class="reason-list">${riskFor(item).reasons.map(reason => `<li>${reason}</li>`).join('') || '<li>準備は順調です。</li>'}</ul><a class="button primary" href="#mypage/${e(item.id)}">新郎新婦の画面で見る</a><a class="button secondary" href="#prep/${e(item.id)}">打ち合わせ準備シート</a></section></div>
    <section class="section-gap"><h2>宿題・提出内容</h2><p class="subtitle">提出済の内容を確認して、確認済にするか修正をお願いします。</p><div class="tasks">${item.tasks.map(task => taskCard(item, task, false)).join('')}</div></section>`;
}

function taskCard(item, task, couple) {
  const editable = ['not_started', 'needs_fix'].includes(task.status);
  const overdue = editable && task.dueDate < todayJst();
  return `<article class="card task-card"><div class="task-header"><h3>${e(task.title)}</h3>${badge(task)}</div><p class="meta">期限 ${dateLabel(task.dueDate)}${overdue ? ' <span class="badge danger">期限を過ぎています</span>' : ''}</p><p class="task-description">${e(task.description)}</p>
    ${task.answer ? `<div class="task-body"><strong>提出内容</strong><p>${e(task.answer)}</p></div>` : ''}
    ${task.feedback ? `<div class="feedback"><strong>プランナーからのお願い</strong><p>${e(task.feedback)}</p></div>` : ''}
    <div class="task-actions">${couple && editable ? button(task.status === 'needs_fix' ? '修正して提出' : '回答して提出', 'submit', taskAttrs(item, task), 'primary') : ''}${!couple && task.status === 'submitted' ? button('確認済にする', 'confirm', taskAttrs(item, task), 'primary') + button('修正をお願いする', 'return', taskAttrs(item, task)) : ''}${task.status === 'confirmed' ? '<p class="muted">プランナーが内容を確認しました。</p>' : couple && task.status === 'submitted' ? '<p class="muted">プランナーの確認をお待ちください。</p>' : !couple && editable ? '<p class="muted">新郎新婦からの提出をお待ちください。</p>' : ''}</div></article>`;
}

function coupleHome(item) {
  const pending = pendingTasks(item).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const remaining = daysUntil(item.weddingDate);
  return `${heading('マイページ', `${e(coupleName(item))} さんの結婚式準備です。`)}<section class="hero"><p>${remaining >= 0 ? '結婚式まで' : '結婚式から'}</p><p class="hero-value">${Math.abs(remaining)}<small>日</small></p><p>${dateLabel(item.weddingDate)} / ${e(item.plan)}</p></section>
    <div class="couple-grid section-gap"><section class="card"><h2>次にやること</h2>${pending.length ? `<p class="meta">未提出の宿題 ${pending.length}件</p><div class="tasks">${pending.slice(0, 3).map(task => `<div class="task-card"><div class="task-header"><h3>${e(task.title)}</h3>${badge(task)}</div><p class="meta">${dateLabel(task.dueDate)}まで</p>${button('回答して提出', 'submit', taskAttrs(item, task), 'primary small')}</div>`).join('')}</div>` : '<p>宿題はすべて提出済です。ご準備ありがとうございます。</p>'}<a class="button secondary section-gap" href="#tasks/${e(item.id)}">すべての宿題を見る</a></section><section class="card stack"><h2>準備の進み具合</h2>${progress(item)}<p>確認済 ${item.tasks.filter(task => task.status === 'confirmed').length} / ${item.tasks.length}件</p><h3>プランナーからのメモ</h3><p class="task-body">${e(item.notes) || 'メモはありません。'}</p><a class="button secondary" href="#timeline/${e(item.id)}">準備のタイムライン</a></section></div>`;
}

function coupleTasks(item) {
  const tasks = item.tasks.filter(task => filters.task === 'all' || (filters.task === 'pending' ? ['not_started', 'needs_fix'].includes(task.status) : task.status === filters.task)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return `${heading('宿題', '入力した回答はデモ内で共有され、実際の送信は行われません。')}<div class="toolbar"><div><label class="field-label" for="task-filter">提出状況</label><select class="field" id="task-filter">${[['all', 'すべて'], ['pending', '未提出'], ['submitted', '提出済'], ['needs_fix', '不備あり'], ['confirmed', '確認済']].map(([value, label]) => `<option value="${value}" ${filters.task === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div><div class="tasks">${tasks.map(task => taskCard(item, task, true)).join('') || '<div class="empty-state">この条件の宿題はありません。</div>'}</div>`;
}

function timelinePage(item) {
  const tasks = [...item.tasks].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return `${heading('準備のタイムライン', '宿題の期限と挙式日を一覧で確認できます。')}<ol class="timeline">${tasks.map(task => `<li class="timeline-item card"><p class="meta">${dateLabel(task.dueDate)}</p><div class="task-header"><h2>${e(task.title)}</h2>${badge(task)}</div><p>${e(task.description)}</p><a class="button secondary small" href="#tasks/${e(item.id)}">宿題を見る</a></li>`).join('')}<li class="timeline-item hero"><p class="meta">${dateLabel(item.weddingDate)}</p><h2>結婚式当日</h2><p>${e(coupleName(item))} さん</p></li></ol>`;
}

function prepPage(item) {
  const pending = pendingTasks(item);
  return `<p class="meta no-print"><a href="#case/${e(item.id)}">案件詳細へ戻る</a></p>${heading('打ち合わせ前準備シート', e(coupleName(item)), button('印刷する', 'print', '', 'secondary no-print'))}<article class="card stack">${caseInfo(item)}<h2>今回確認したいこと</h2><ul class="reason-list">${pending.map(task => `<li>${e(task.title)} / ${STATUS_LABELS[task.status]} / 期限 ${dateLabel(task.dueDate)}</li>`).join('') || '<li>未提出の宿題はありません。</li>'}</ul><h2>確認待ちの提出</h2><ul class="reason-list">${item.tasks.filter(task => task.status === 'submitted').map(task => `<li><strong>${e(task.title)}</strong><p class="task-body">${e(task.answer)}</p></li>`).join('') || '<li>確認待ちの提出はありません。</li>'}</ul><h2>打ち合わせメモ</h2><p class="task-body">${e(item.notes) || 'メモはありません。'}</p><p class="muted">ログイン不要デモ / 架空データ</p></article>`;
}

function openModal(value, opener) {
  returnFocus = opener;
  modal = value;
  render();
}

function closeModal() {
  const focus = returnFocus;
  modal = null;
  render();
  if (focus) {
    const selector = `button[data-action="${CSS.escape(focus.action)}"]${focus.case ? `[data-case="${CSS.escape(focus.case)}"]` : ''}${focus.task ? `[data-task="${CSS.escape(focus.task)}"]` : ''}`;
    app.querySelector(selector)?.focus();
  }
}

function renderModal() {
  let title; let content;
  if (modal.kind === 'reset') {
    title = 'デモを初期化';
    content = `<p>このブラウザ内で変更したデモデータを、最初の5案件に戻します。</p><div class="actions section-gap">${button('キャンセル', 'close-modal')}${button('初期化する', 'reset-confirm', '', 'danger')}</div>`;
  } else if (modal.kind === 'case') {
    const item = caseFor(modal.caseId);
    title = item ? '案件情報を変更' : '案件を登録';
    content = `<form id="case-form" class="form-grid"><div><label class="field-label" for="groom">新郎のお名前</label><input class="field" id="groom" name="groom" maxlength="80" required value="${e(item?.groom || '')}"></div><div><label class="field-label" for="bride">新婦のお名前</label><input class="field" id="bride" name="bride" maxlength="80" required value="${e(item?.bride || '')}"></div><div><label class="field-label" for="wedding-date">挙式日</label><input class="field" id="wedding-date" name="weddingDate" type="date" min="${todayJst()}" required value="${item?.weddingDate || shiftDate(todayJst(), 120)}"></div><div><label class="field-label" for="plan">プラン</label><select id="plan" class="field" name="plan">${PLANS.map(plan => `<option ${plan === item?.plan ? 'selected' : ''}>${plan}</option>`).join('')}</select></div><div><label class="field-label" for="guests">ゲスト数</label><input id="guests" class="field" name="guestCount" type="number" min="1" max="1000" required value="${item?.guestCount || 20}"></div><div class="span-full"><label class="field-label" for="notes">打ち合わせメモ</label><textarea class="field" id="notes" name="notes" rows="4" maxlength="2000">${e(item?.notes || '')}</textarea></div><p id="form-error" class="feedback span-full" role="alert" hidden></p><div class="actions span-full">${button('キャンセル', 'close-modal')}<button class="button primary" type="submit">${item ? '変更を保存' : '案件を登録'}</button></div></form>`;
  } else {
    const item = caseFor(modal.caseId);
    const task = item.tasks.find(entry => entry.id === modal.taskId);
    title = modal.kind === 'submit' ? `${e(task.title)}を提出` : '修正をお願いする';
    const field = modal.kind === 'return'
      ? '<label class="field-label" for="answer">修正してほしい内容</label><textarea class="field" id="answer" name="answer" rows="5" maxlength="1000" required placeholder="新郎新婦に伝えたい内容を入力してください"></textarea>'
      : task.type === 'select'
        ? `<label class="field-label" for="answer">回答</label><select id="answer" class="field" name="answer" required><option value="">選んでください</option>${task.options.map(option => `<option value="${e(option)}" ${task.answer === option ? 'selected' : ''}>${e(option)}</option>`).join('')}</select>`
        : `<label class="field-label" for="answer">回答</label><textarea class="field" id="answer" name="answer" rows="6" maxlength="2000" required>${e(task.answer)}</textarea>`;
    content = `<p class="task-description">${e(task.description)}</p><form id="task-form" class="stack">${field}<p id="form-error" class="feedback" role="alert" hidden></p><div class="actions">${button('キャンセル', 'close-modal')}<button class="button primary" type="submit">${modal.kind === 'return' ? '修正をお願いする' : 'デモ内で提出'}</button></div></form>`;
  }
  return `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><h2 id="modal-title">${title}</h2><button type="button" class="close-button" data-action="close-modal" aria-label="閉じる">×</button></div>${content}</section></div>`;
}

app.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const { action, case: caseId, task: taskId } = control.dataset;
  try {
    if (action === 'role') {
      role = control.dataset.role;
      location.hash = role === 'planner' ? `case/${selectedId}` : `mypage/${selectedId}`;
    } else if (action === 'reset') openModal({ kind: 'reset' }, control.dataset);
    else if (action === 'reset-confirm') {
      const saved = persist(seedData()); modal = null; filters.query = ''; filters.risk = 'all'; filters.task = 'all';
      selectedId = state.cases[0].id; role = 'planner'; location.hash = 'dashboard'; render();
      if (saved) showNotice('デモを最初の5案件に戻しました。');
    } else if (action === 'close-modal') closeModal();
    else if (action === 'new-case' || action === 'edit-case') openModal({ kind: 'case', caseId }, control.dataset);
    else if (action === 'submit' || action === 'return') openModal({ kind: action, caseId, taskId }, control.dataset);
    else if (action === 'confirm') {
      const saved = persist(transitionTask(state, caseId, taskId, 'confirm')); render();
      if (saved) showNotice('提出内容を確認済にしました。');
    } else if (action === 'print') window.print();
  } catch (error) { showNotice(error.message); }
});

app.addEventListener('submit', event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.target));
  try {
    let saved;
    let message;
    if (event.target.id === 'case-form') {
      const result = saveCase(state, fields, modal.caseId);
      saved = persist(result.state); selectedId = result.caseId;
      message = modal.caseId ? '案件情報を保存しました。' : 'デモの案件を登録しました。';
      modal = null; location.hash = `case/${selectedId}`;
    } else if (event.target.id === 'task-form') {
      saved = persist(transitionTask(state, modal.caseId, modal.taskId, modal.kind === 'submit' ? 'submit' : 'return', fields.answer));
      message = modal.kind === 'submit' ? 'デモ内で宿題を提出しました。プランナーに切り替えて確認できます。' : '修正をお願いしました。新郎新婦の画面に表示されます。';
      modal = null;
    } else return;
    render(true); if (saved) showNotice(message);
  } catch (error) {
    const errorArea = document.getElementById('form-error');
    errorArea.textContent = error.message; errorArea.hidden = false;
  }
});

app.addEventListener('input', event => {
  if (event.target.id !== 'case-search') return;
  filters.query = event.target.value;
  document.getElementById('cases-results').innerHTML = casesResults();
  document.getElementById('results-count').textContent = `${filteredCases().length}件の案件`;
});

app.addEventListener('change', event => {
  if (event.target.id === 'risk-filter') { filters.risk = event.target.value; render(); }
  else if (event.target.id === 'task-filter') { filters.task = event.target.value; render(); }
  else if (event.target.id === 'couple-case') {
    const page = route().page;
    selectedId = event.target.value;
    location.hash = `${page}/${selectedId}`;
  }
});

document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  document.getElementById('main-content').focus();
});

document.addEventListener('keydown', event => {
  if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
  if (event.key !== 'Tab') return;
  const elements = [...app.querySelectorAll('[role="dialog"] button, [role="dialog"] input, [role="dialog"] textarea, [role="dialog"] select')];
  const first = elements[0]; const last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

window.addEventListener('hashchange', () => { modal = null; render(true); });
render();
if (loaded.unavailable || storage === memoryStorage) showNotice('ブラウザ保存を利用できません。デモの操作はこの画面を開いている間だけ残ります。');
else if (loaded.recovered) showNotice('保存データを読み込めなかったため、最初のデモデータを表示しています。');
