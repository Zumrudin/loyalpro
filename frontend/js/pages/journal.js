// Staff journal. Upstream data is escaped; no patient data is stored in browser storage.
const journal = { data: null, week: null, view: 'day', request: 0, modalRequest: 0, slotRequest: 0, busy: false, draft: null, slots: [], preferredTime: null };
// Phone layout threshold: the same number is in journal.css (@media (max-width:700px)) — change both together.
const JR_MOBILE_MAX = 700;
const jrIsMobile = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(`(max-width: ${JR_MOBILE_MAX}px)`).matches;
const jrEl = id => document.getElementById(id);
const jrEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jrToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const JR_PX_PER_MIN = 1.6;
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
  jrEl('jrReview').hidden = typeof ME === 'undefined' || ME?.role !== 'owner';
  const date = jrEl('jrDate').value;
  const request = ++journal.request;
  clearTimeout(journal.pollTimer); journal.pollTimer = null;
  if (!silent) {
    jrEl('jrState').textContent = 'Загружаем расписание…';
    jrEl('jrGrid').innerHTML = '';
    jrEl('jrNew').disabled = true;
    journal.data = null;
  }
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
    jrUpdateStaffFilter();
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
  if (!onPage() || !(journal.view === 'week' && journal.week ? journal.week.days.flatMap(d => d.records || []) : (journal.data?.records || [])).some(jrSyncing)) return;
  journal.pollTimer = setTimeout(() => {
    journal.pollTimer = null;
    if (onPage() && !document.hidden) loadJournal({ silent: true });
  }, 5000);
}
function jrStaffList() {
  // Do not resurrect administrators/off-day staff from existing appointments.
  return (journal.data?.staff || []).filter(s => !jrEl('jrWorkingOnly').checked || s.working === true);
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
  };
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
function jrStub(label, icon = 'file', extra = '') {
  return `<button type="button" class="jr-placeholder ${extra}" disabled title="${jrEscape(label)} — скоро появится в журнале">${jrIcon(icon)}<span>${jrEscape(label)}</span><small>Скоро</small></button>`;
}
function jrShowModal(title, wide = false) {
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
