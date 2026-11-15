// Staff journal. Upstream data is escaped; no patient data is stored in browser storage.
const JR_GRID_CELL_PX = 24, JR_GRID_STEPS = [5, 10, 15], JR_GRID_STEP_KEY = 'loyalpro.journal.gridStep';
function jrStoredGridStep() {
  try {
    const value = typeof localStorage !== 'undefined' ? Number(localStorage.getItem(JR_GRID_STEP_KEY)) : NaN;
    return JR_GRID_STEPS.includes(value) ? value : 15;
  } catch (_) { return 15; }
}
const journal = { data: null, week: null, view: 'day', request: 0, modalRequest: 0, slotRequest: 0, sectionRequest: 0, busy: false, draft: null, slots: [], preferredTime: null, gridStep: jrStoredGridStep() };
// Phone layout threshold: the same number is in journal.css (@media (max-width:700px)) — change both together.
const JR_MOBILE_MAX = 700;
const jrIsMobile = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(`(max-width: ${JR_MOBILE_MAX}px)`).matches;
const jrEl = id => document.getElementById(id);
const jrEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jrToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const jrGridStep = () => JR_GRID_STEPS.includes(Number(journal.gridStep)) ? Number(journal.gridStep) : 15;
const jrPxPerMin = () => JR_GRID_CELL_PX / jrGridStep();
const jrMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const jrTimeLabel = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const jrStatus = r => r.deleted ? 'Удалена' : ({ '-1': 'Не пришёл / отменена', 0: 'Ожидание', 1: 'Пришёл', 2: 'Подтверждена' }[r.attendance] || 'Ожидание');
async function jrApi(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
  const response = await fetch('/api/journal/' + path, {
    signal: controller.signal,
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store',
  });
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('Сервер не ответил. Обновите журнал.'); }
  if (!response.ok) { const e = new Error(data.error || 'Не удалось выполнить действие.'); e.code = data.code; e.status = response.status; throw e; }
  return data;
  } catch(e) { if(e.name==='AbortError') throw new Error('Время ожидания истекло. Повторите действие.'); throw e; }
  finally { clearTimeout(timer); }
}
async function loadJournal(opts = {}) {
  const silent = !!opts?.silent;
  if (!jrEl('jrDate').value) jrEl('jrDate').value = jrToday();
  if (typeof jrToolbarSync === 'function') jrToolbarSync();
  jrEl('jrReview').hidden = typeof ME === 'undefined' || ME?.role !== 'owner';
  const date = jrEl('jrDate').value;
  const request = ++journal.request;
  // Summary has its own stale-response guard and must not delay the grid.
  if (typeof jrSummaryLoad === 'function') void jrSummaryLoad(date);
  clearTimeout(journal.pollTimer); journal.pollTimer = null;
  if (!silent) {
    jrEl('jrState').textContent = 'Загружаем расписание…';
    jrEl('jrGrid').innerHTML = '';
    jrEl('jrNew').disabled = true;
    journal.data = null;
  }
  if (typeof jrToolbarSummarySync === 'function') jrToolbarSummarySync();
  try {
    // Week = one master x 7 days; the day is still loaded: forms need its services/staff.
    if (jrIsMobile() && journal.view !== 'day') { journal.view = 'day'; jrSyncViewButtons(); }
    const staffId = jrEl('jrStaffFilter').value;
    const [data, week] = await Promise.all([
      jrApi('day?' + new URLSearchParams({ date })),
      journal.view === 'week' ? jrApi('week?' + new URLSearchParams({ date, ...(staffId ? { staffId } : {}) })) : Promise.resolve(null),
    ]);
    if (request !== journal.request) return;
    journal.week = week;
    const grid = jrEl('jrGrid'), scroll = [grid.scrollTop, grid.scrollLeft];
    journal.data = data;
    if (typeof jrToolbarSummarySync === 'function') jrToolbarSummarySync();
    jrUpdateStaffFilter();
    if (typeof jrToolbarSync === 'function') jrToolbarSync();
    jrEl('jrState').textContent = jrFreshnessText(data);
    jrEl('jrNew').disabled = !data.staff.length;
    jrUpdateDispatchButton(data.unsent);
    jrRender();
    if (silent) { if (scroll[0] != null) grid.scrollTop = scroll[0]; if (scroll[1] != null) grid.scrollLeft = scroll[1]; }
  } catch (e) {
    if (request === journal.request && !silent) jrEl('jrState').textContent = e.message;
  }
  if (request === journal.request) jrSchedulePoll();
}
const jrClock = value => new Date(value).toLocaleTimeString('ru', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
function jrFreshnessText(data) {
  return `Обновлено ${jrClock(data?.fetchedAt ? data.fetchedAt : Date.now())} · московское время`;
}
// Manual dispatch (10.11.2026): changes wait in the journal until «Отправить
// в YClients»; only a released package is «on its way».
const jrSyncing = r => ['queued', 'running'].includes(r?.sync?.status) && r.sync.released !== false;
const jrUnsent = r => r?.sync?.status === 'queued' && r.sync.released === false;
// Poll only our own DB (no YClients) while packages are still on their way.
function jrSchedulePoll() {
  clearTimeout(journal.pollTimer); journal.pollTimer = null;
  const onPage = () => document.body?.dataset?.page === 'journal';
  const scheduleSending = (journal.data?.staff || []).some(s => jrSyncing({ sync: s.scheduleSync })) || (journal.week?.days || []).some(d => jrSyncing({ sync: d.scheduleSync }));
  if (!onPage() || (!scheduleSending && !(journal.view === 'week' && journal.week ? journal.week.days.flatMap(d => d.records || []) : (journal.data?.records || [])).some(jrSyncing))) return;
  journal.pollTimer = setTimeout(() => {
    journal.pollTimer = null;
    if (onPage() && !document.hidden) loadJournal({ silent: true });
  }, 5000);
}
function jrStaffList() {
  // Do not resurrect administrators/off-day staff from existing appointments.
  return (journal.data?.staff || []).filter(s => !jrEl('jrWorkingOnly').checked || s.working === true || !!s.scheduleSync);
}
function jrUpdateStaffFilter() {
  const week = journal.view === 'week' ? journal.week : null;
  if (week?.staff) {
    // Week = one master: the list is the whole roster (an off-day master stays selectable), no «all».
    const sel = jrEl('jrStaffFilter');
    sel.innerHTML = (week.allStaff || [week.staff]).map(s => `<option value="${s.id}">${jrEscape(s.name)}</option>`).join('');
    sel.value = String(week.staff.id);
    return;
  }
  const select = jrEl('jrStaffFilter'), prev = select.value, staff = jrStaffList();
  select.innerHTML = '<option value="">Все сотрудники</option>' + staff.map(s => `<option value="${s.id}">${jrEscape(s.name)}</option>`).join('');
  select.value = staff.some(s => String(s.id) === prev) ? prev : '';
}
function jrShift(days) {
  if (journal.view === 'week') days *= 7;
  const d = new Date((jrEl('jrDate').value || jrToday()) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days); jrEl('jrDate').value = d.toISOString().slice(0, 10); loadJournal();
}
function jrSetView(view) {
  journal.view = view === 'week' && !jrIsMobile() ? 'week' : 'day';
  jrSyncViewButtons();
  loadJournal();
}
function jrSyncViewButtons() {
  for (const [id, v] of [['jrViewDay', 'day'], ['jrViewWeek', 'week']]) {
    const b = jrEl(id);
    b.classList?.toggle('is-active', journal.view === v);
    b.setAttribute?.('aria-pressed', String(journal.view === v));
  }
}
// In the week the master is part of the request; in the day the filter is local.
function jrStaffChanged() {
  if (journal.view === 'week') loadJournal({ silent: true });
  else jrRender();
}
// Shared appointment-window components. Placeholder controls never issue API calls.
function jrIcon(name) {
  const paths = {
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0116 0v2"/>',
    file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
    box: '<path d="M12 3l9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7 5.8l9 5"/>',
    check: '<path d="M5 12l4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    repeat: '<path d="M3 11V8a4 4 0 014-4h12l-3-3M21 13v3a4 4 0 01-4 4H5l3 3M19 4l-3 3M5 20l3-3"/>',
    bell: '<path d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 8V4a1 1 0 011-1h14M16 11h5v5h-5z"/>',
    chat: '<path d="M21 11a9 9 0 01-9 9H4l-3 3V11a10 10 0 0120 0zM6 9h10M6 13h7"/>',
    move: '<path d="M12 2v20M2 12h20M8 6l4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4"/>',
    pin: '<path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5M9 10l5 5M14 4l6 6"/>',
    minus: '<path d="M5 12h14"/>',
    pencil: '<path d="M16 3l5 5L8 21H3v-5zM13 6l5 5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    card: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
    cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v.01M18 15v.01"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    dots: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6"/>',
    folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    medcard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M12 9v6M9 12h6"/>',
    receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6"/>',
    loyalty: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M9 10l1.5 1.5L15 8M8 16h8"/>',
    egisz: '<path d="M12 4v16M4 12h16M8 4h8v4M8 20h8v-4"/>',
  };
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
function jrStub(label, icon = 'file', extra = '') {
  return `<button type="button" class="jr-placeholder ${extra}" disabled title="${jrEscape(label)} — скоро появится в журнале">${jrIcon(icon)}<span>${jrEscape(label)}</span><small>Скоро</small></button>`;
}
// Keep the actual form and client controls alive while a client section is open.
function jrSectionBody() {
  return journal.section?.page || jrEl('jrModalBody');
}
function jrSectionActive() {
  return !!(journal.section && !journal.section.closing && journal.section.page?.isConnected);
}
function jrSectionOpen(title, className = '') {
  const body = jrEl('jrModalBody'), modal = jrEl('jrModal');
  if (!body?.querySelector?.('.jr-booking-layout') || journal.busy) return null;
  if (journal.section?.closing) journal.section.finish();
  const previous = journal.section;
  if (previous) {
    // Switching tiles keeps the already-open layout, including sidebar scroll.
    previous.title = title;
    previous.request = journal.sectionRequest = (journal.sectionRequest || 0) + 1;
    previous.content.className = 'jr-section-content ' + className;
    previous.content.setAttribute('aria-label', title);
    previous.content.querySelector('h2').textContent = title;
    previous.page.innerHTML = '<p class="jr-hint">Загрузка…</p>';
    jrEl('jrModalTitle').textContent = title;
    jrMessage('');
    return previous;
  }
  const watchId = journal.cardWatch?.id;
  jrStopRecordWatch();
  const focus = document.activeElement, scroll = modal.scrollTop, error = jrEl('jrModalError').textContent;
  const viewport = document.createElement('div'); viewport.className = 'jr-section-shell';
  const track = document.createElement('div'); track.className = 'jr-section-track';
  const card = document.createElement('section'); card.className = 'jr-section-record';
  while (body.firstChild) card.appendChild(body.firstChild);
  const split = document.createElement('section'); split.className = 'jr-section-split';
  const client = document.createElement('aside'); client.className = 'jr-section-client';
  const content = document.createElement('section'); content.className = 'jr-section-content ' + className;
  content.setAttribute('aria-label', title);
  content.innerHTML = `<header class="jr-section-head"><h2>${jrEscape(title)}</h2><button type="button" class="btn btn-sec jr-section-close">Закрыть</button></header>`;
  const page = document.createElement('div'); page.className = 'jr-section-content-body';
  page.innerHTML = '<p class="jr-hint">Загрузка…</p>'; content.appendChild(page);
  const clientNode = card.querySelector('.jr-booking-client');
  // A noninteractive snapshot fills the outgoing card during the transition.
  const placeholder = clientNode.cloneNode(true);
  placeholder.removeAttribute('id');
  placeholder.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  placeholder.inert = true; placeholder.setAttribute('aria-hidden', 'true');
  clientNode.replaceWith(placeholder); client.appendChild(clientNode);
  const footer = card.querySelector('.jr-booking-footer');
  const footerAnchor = document.createComment('footer');
  if (footer) footer.replaceWith(footerAnchor);
  split.append(client, content); track.append(card, split); viewport.appendChild(track);
  body.appendChild(viewport); if (footer) body.appendChild(footer);
  const state = journal.section = { title, viewport, track, card, split, client, content, page, clientNode, placeholder, footer, footerAnchor, body, focus, scroll, error, watchId,
    request: journal.sectionRequest = (journal.sectionRequest || 0) + 1 };
  modal.classList.add('jr-dialog-section'); modal.scrollTop = 0;
  jrEl('jrModalTitle').textContent = title; jrMessage('');
  const close = content.querySelector('.jr-section-close'); close.onclick = () => jrSectionClose();
  card.inert = true;
  // Force the initial position to be laid out before starting the transition.
  void track.offsetWidth;
  viewport.classList.add('is-section-open');
  close.focus({ preventScroll: true });
  return state;
}
function jrSectionClose(force = false) {
  const state = journal.section;
  if (!state) return false;
  if (state.closing) { if (force) state.finish(); return true; }
  state.closing = true;
  journal.sectionRequest = (journal.sectionRequest || 0) + 1;
  state.split.inert = true;
  state.viewport.classList.remove('is-section-open');
  const finish = state.finish = () => {
    if (state.finished) return;
    state.finished = true; clearTimeout(state.timer);
    state.track.removeEventListener('transitionend', onEnd);
    state.placeholder.replaceWith(state.clientNode);
    if (state.footer) state.footerAnchor.replaceWith(state.footer);
    // Only restore into the same live shell; never overwrite a new modal.
    if (state.viewport.parentNode === state.body) {
      while (state.card.firstChild) state.body.insertBefore(state.card.firstChild, state.viewport);
      state.viewport.remove();
    }
    if (journal.section === state) journal.section = null;
    const modal = jrEl('jrModal'); modal.classList.remove('jr-dialog-section');
    jrEl('jrModalTitle').textContent = 'Карточка записи';
    jrMessage(state.error);
    modal.scrollTop = state.scroll;
    if (!force) {
      state.focus?.isConnected && state.focus.focus({ preventScroll: true });
      if (state.watchId && !journal.session?.edit) jrWatchRecord(state.watchId);
    }
  };
  const onEnd = event => { if (event.target === state.track && event.propertyName === 'transform') finish(); };
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (force || reduced) finish();
  else { state.track.addEventListener('transitionend', onEnd); state.timer = setTimeout(finish, 380); }
  return true;
}
function jrShowModal(title, wide = false) {
  // Opening a different modal (payment, move form, another record) leaves the
  // embedded detail page first so it cannot retain stale nodes or responses.
  jrSectionClose(true);
  jrStopRecordWatch();
  jrEl('jrModal').querySelectorAll('button').forEach(el=>el.disabled=false);
  jrEl('jrModalTitle').textContent = title;
  jrEl('jrModalBody').innerHTML = '<p>Загрузка…</p>';
  jrEl('jrModalError').textContent = '';
  const modal = jrEl('jrModal');
  if (modal.dataset) { delete modal.dataset.status; delete modal.dataset.paidFull; }
  jrHideCloseAsk();
  modal.className = 'jr-dialog' + (wide ? ' jr-dialog-wide' : '');
  if (!modal.open) modal.showModal();
}
// One opening of a form = one session; everything done there is sent once.
const jrNewSession = extra => ({ sessionId: crypto.randomUUID(), ...extra });
function jrSessionPending() {
  const s = journal.session;
  return !!(s?.edit || (journal.payment && s && (s.create || s.payments?.length || s.removePayments?.length || s.dropPayments?.length)));
}
function jrMessage(message) { jrEl('jrModalError').textContent = message; }
async function jrWithBusy(message, fn) {
  if (journal.busy) return;
  journal.busy = true; jrMessage(message);
  const modal = jrEl('jrModal');
  modal.classList?.add('jr-payment-busy');
  const controls = Array.from(modal.querySelectorAll('button,input,select,textarea'));
  const disabled = controls.map(el => el.disabled); controls.forEach(el => { el.disabled = true; });
  try { return await fn(); }
  finally {
    journal.busy = false;
    modal.classList?.remove('jr-payment-busy');
    controls.forEach((el, i) => { el.disabled = disabled[i]; });
  }
}
function jrSessionBody() {
  const s = journal.session, body = { sessionId: s.sessionId };
  if (s.create) body.create = s.create; else body.recordId = s.recordId;
  if (s.edit) body.edit = { ...s.edit, ...(s.servicesVersion ? { servicesVersion: s.servicesVersion } : {}) };
  if (s.payments?.length) body.payments = s.payments.map(p => ({ ...p }));
  if (s.removePayments?.length) body.removePayments = s.removePayments.map(p => ({ ...p }));
  if (s.dropPayments?.length) body.dropPayments = s.dropPayments.map(p => ({ outboxId: p.outboxId, opId: p.opId }));
  return body;
}
// The server only stores the session (fractions of a second), so the form
// closes as soon as it answers.
async function jrSave(body) {
  let ok = false, used = false, res = null;
  await jrWithBusy('Сохраняем…', async () => {
    try { res = await jrApi('sessions', body); ok = true; }
    catch (e) {
      // The key was stored earlier (a lost response) with other contents: the
      // earlier package is in the journal; a new key would make a second one.
      if (e.code === 'session_used') { used = true; return; }
      jrMessage(e.message);
      // A definite rejection was not stored: the corrected attempt is a new session.
      // A lost response keeps the key, so a repeat cannot duplicate the session.
      if (e.status >= 400 && e.status < 500 && journal.session?.sessionId === body.sessionId) journal.session.sessionId = crypto.randomUUID();
    }
  });
  if (used) {
    jrMessage(''); jrClose(true);
    notify('Изменения уже сохранены ранее. Проверьте запись в журнале.', 'err');
    loadJournal({ silent: true });
    return false;
  }
  if (!ok) return false;
  jrMessage(''); jrClose(true);
  loadJournal({ silent: true });
  if (res?.status === 'cancelled') notify('Запись удалена из журнала.');
  else notify('Сохранено в журнале.');
  return true;
}
jrEl('jrModal').addEventListener('cancel', event => { event.preventDefault(); jrClose(); });
