// Staff journal. Upstream data is escaped; no patient data is stored in browser storage.
const journal = { data: null, request: 0, modalRequest: 0, slotRequest: 0, busy: false, draft: null, slots: [], preferredTime: null };
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
    const data = await jrApi('day?' + new URLSearchParams({ date }));
    if (request !== journal.request) return;
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
  const mirror = data?.freshness?.mirrorOkAt ? Date.parse(data.freshness.mirrorOkAt) : NaN;
  if (Number.isFinite(mirror) && Date.now() - mirror > 30 * 60000) return `Данные YClients обновлены ${jrClock(mirror)} · московское время`;
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
  if (!onPage() || !(journal.data?.records || []).some(jrSyncing)) return;
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
  const select = jrEl('jrStaffFilter'), prev = select.value, staff = jrStaffList();
  select.innerHTML = '<option value="">Все сотрудники</option>' + staff.map(s => `<option value="${s.id}">${jrEscape(s.name)}</option>`).join('');
  select.value = staff.some(s => String(s.id) === prev) ? prev : '';
}
function jrCellState(staff, minute, date, records, now = Date.now()) {
  if (!(staff.workRanges || []).some(r => minute >= r.start && minute + 15 <= r.end)) return 'off';
  if (Date.parse(date + 'T00:00:00+03:00') + minute * 60000 <= now) return 'past';
  // Use ALL appointments, including those hidden by a search filter.
  if (records.some(r => r.staffId === staff.id && !r.deleted && r.time &&
    minute < jrMinutes(r.time) + (r.duration > 0 ? r.duration : 15) && minute + 15 > jrMinutes(r.time))) return 'busy';
  return 'free';
}
function jrGridCreate(staffId, time) {
  const staff = jrStaffList().find(s => s.id === staffId);
  if (!staff || !journal.data || jrCellState(staff, jrMinutes(time), journal.data.date, journal.data.records) !== 'free') return;
  jrForm(null, { staffId, time, date: journal.data.date });
}
function jrShift(days) {
  const d = new Date((jrEl('jrDate').value || jrToday()) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days); jrEl('jrDate').value = d.toISOString().slice(0, 10); loadJournal();
}
function jrLayout(records) {
  // Overlaps occupy separate lanes; neither appointment covers the other.
  const sorted = records.filter(r => /^\d\d:\d\d$/.test(r.time || '')).map(r => ({ ...r,
    start: Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3, 5)),
  })).sort((a, b) => a.start - b.start || a.id - b.id);
  let group = [], end = -1;
  const finish = () => {
    const lanes = [];
    for (const r of group) {
      let lane = lanes.findIndex(t => t <= r.start);
      if (lane < 0) lane = lanes.length;
      r.lane = lane; lanes[lane] = r.start + Math.max(r.duration || 15, 5);
    }
    group.forEach(r => { r.lanes = lanes.length; });
  };
  for (const r of sorted) {
    if (r.start >= end) { finish(); group = []; end = -1; }
    group.push(r); end = Math.max(end, r.start + Math.max(r.duration || 15, 5));
  }
  finish(); return sorted;
}
function jrRender() {
  if (!journal.data) return;
  const filter = jrEl('jrStaffFilter').value;
  const staff = jrStaffList().filter(s => !filter || String(s.id) === filter);
  const query = jrEl('jrSearch').value.trim().toLowerCase();
  const allRecords = journal.data.records;
  const records = allRecords.filter(r => staff.some(s => s.id === r.staffId) && (!query || [r.clientName, ...r.services.map(s => s.title)].join(' ').toLowerCase().includes(query)));
  const grid = jrEl('jrGrid');
  if (!staff.length) { grid.innerHTML = `<p class="jr-empty">${jrEl('jrWorkingOnly').checked ? 'На выбранную дату нет работающих специалистов. Снимите фильтр «Только работающие», чтобы увидеть остальных.' : 'Специалистов пока нет.'}</p>`; return; }
  const ranges = staff.flatMap(s => s.workRanges || []);
  const times = records.filter(r => r.time).map(r => jrMinutes(r.time));
  const start = Math.max(0, Math.min(8 * 60, ...times.map(t => Math.floor(t / 60) * 60), ...ranges.map(r => Math.floor(r.start / 60) * 60)));
  const ends = records.filter(r => r.time).map(r => jrMinutes(r.time) + (r.duration || 15));
  const end = Math.min(1440, Math.max(21 * 60, ...ends.map(t => Math.ceil(t / 60) * 60), ...ranges.map(r => Math.ceil(r.end / 60) * 60)));
  const height = (end - start) * JR_PX_PER_MIN;
  let labels = '';
  for (let t = start; t < end; t += 15) labels += `<span class="${t % 60 ? 'jr-quarter' : 'jr-hour'}" style="top:${(t - start) * JR_PX_PER_MIN}px">${t % 60 ? String(t % 60).padStart(2, '0') : jrTimeLabel(t)}</span>`;
  const now = Date.now();
  grid.innerHTML = `<div class="jr-calendar" style="--jr-columns:${staff.length};--jr-height:${height}px"><div class="jr-corner">Время</div>${staff.map(s => `<div class="jr-heading">${jrEscape(s.name)}<small>${s.working ? (s.workRanges || []).map(r => jrTimeLabel(r.start) + '–' + jrTimeLabel(r.end)).join(', ') || 'Рабочий день' : 'Выходной'} · ${records.filter(r => r.staffId === s.id).length} записей</small></div>`).join('')}<div class="jr-hours">${labels}</div>${staff.map(s => {
    let cells = '';
    for (let t = start; t < end; t += 15) {
      const state = jrCellState(s, t, journal.data.date, allRecords, now), time = jrTimeLabel(t);
      const position = `top:${(t - start) * JR_PX_PER_MIN}px;height:${15 * JR_PX_PER_MIN}px`;
      const classes = `jr-cell jr-cell-${state}${t % 60 === 0 ? ' jr-cell-hour' : ''}`;
      cells += state === 'free'
        ? `<button type="button" class="${classes}" data-staff="${s.id}" data-time="${time}" style="${position}" aria-label="${jrEscape(time + ' — новая запись, ' + s.name)}"><span>${time} Новый сеанс</span></button>`
        : `<div class="${classes}" style="${position}" aria-hidden="true"></div>`;
    }
    return `<div class="jr-column">${cells}${jrLayout(records.filter(r => r.staffId === s.id)).map(r => {
      const length = Math.min(Math.max(r.duration || 15, 5), end - r.start);
      const syncing = jrSyncing(r), failed = r.sync?.status === 'failed', unsent = jrUnsent(r);
      const title = r.time + ' · ' + r.clientName + ' · ' + r.services.map(x => x.title).join(', ') + (failed ? ' · Не передано в YClients: ' + (r.sync.errorText || 'причина неизвестна') : syncing ? ' · передаётся в YClients' : unsent ? ' · не отправлено в YClients' : '');
      return `<button type="button" class="jr-visit jr-status-${r.attendance}${r.paidFull ? ' jr-paid-full' : ''}${length < 30 ? ' jr-visit-short' : ''}${syncing ? ' jr-visit-syncing' : ''}${unsent ? ' jr-visit-unsent' : ''}${failed ? ' jr-visit-failed' : ''}" data-record="${r.id}" style="top:${(r.start - start) * JR_PX_PER_MIN}px;height:${Math.max(6, length * JR_PX_PER_MIN - 2)}px;left:calc(${r.lane * 100 / r.lanes}% + 3px);width:calc(${100 / r.lanes}% - 6px)" title="${jrEscape(title)}" aria-label="${jrEscape(r.time + ' ' + r.clientName + ', ' + jrStatus(r) + (failed ? ', не передано в YClients' : syncing ? ', передаётся в YClients' : unsent ? ', не отправлено в YClients' : ''))}"><b>${syncing ? '⏳ ' : ''}${jrEscape(r.time)} · ${jrEscape(r.clientName)}</b><span>${jrEscape(r.services.map(x => x.title).join(', ') || 'Без услуг')}</span><small>${r.continued ? 'Продолжение · ' : ''}${jrEscape(jrStatus(r))}${r.paid ? ' · оплачено' : ''}</small>${failed ? '<small class="jr-sync-failed-note">Не передано в YClients</small>' : unsent ? '<small class="jr-sync-unsent-note">Не отправлено в YClients</small>' : ''}</button>`;
    }).join('')}</div>`;
  }).join('')}</div>`;
  grid.querySelectorAll('[data-record]').forEach(el => el.addEventListener('click', () => jrOpen(Number(el.dataset.record))));
  grid.querySelectorAll('[data-time]').forEach(el => el.addEventListener('click', () => jrGridCreate(Number(el.dataset.staff), el.dataset.time)));
  if (!records.length && query) grid.insertAdjacentHTML('afterbegin', '<p class="jr-empty">Записей по запросу не найдено. Занятые интервалы остаются недоступны.</p>');
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
function jrTools() {
  return `<div class="jr-tools">${[['ЕГИСЗ','plus'],['Текущий приём','file'],['Расширенные поля','list'],['Повторение записи','repeat'],['Уведомления о визите','bell'],['Списание расходников','box'],['История изменений','clock'],['Лист назначения','file']].map(([title,icon]) => jrStub(title,icon)).join('')}</div>`;
}
function jrClientPanel(record, creating = false) {
  return `<aside class="jr-booking-client jr-booking-panel"><div class="jr-client-tabs"><span class="is-active">${jrIcon('user')} Клиент</span>${jrStub('Чат','chat','jr-tab-stub')}</div>${creating
    ? '<div class="jr-fields"><label>Имя клиента<input id="jrName" required maxlength="120" autocomplete="off" placeholder="Имя и фамилия"></label><label>Телефон с кодом страны<input id="jrPhone" required type="tel" maxlength="24" autocomplete="off" placeholder="Введите номер телефона"></label></div>'
    : `<div class="jr-client-identity">${jrIcon('user')}<h3>${jrEscape(record?.clientName || 'Клиент')}</h3></div>`}
    ${jrStub('Сменить клиента','user','jr-stub-inline')}
    <div class="jr-client-tools">${[['Планы лечения','file'],['Медкарта','plus'],['История посещений','clock'],['Лояльность','wallet'],['Счета клиента','wallet']].map(([title,icon]) => jrStub(title,icon)).join('')}</div>
    <label class="jr-other-visitor"><input type="checkbox" disabled> Записывает другого посетителя <small>Скоро</small></label>
    <section class="jr-client-info"><h4>Дополнительно</h4><p>Примечание о клиенте<span>—</span></p><p>Дата рождения<span>—</span></p><p>Номер договора<span>—</span></p></section>
    <section class="jr-client-info"><h4>Статистика</h4><div class="jr-client-stats"><p>Последний визит<span>—</span></p><p>Всего визитов<span>—</span></p></div><small>Данные карточки клиента пока не подключены к журналу.</small></section>
  </aside>`;
}
function jrPaymentPanel(record) {
  const state = !record ? 'Оплата после создания записи' : record.paymentSync ? 'Оплата передаётся в YClients…' : record.paid ? 'Есть отметка об оплате' : 'Оплата не отмечена';
  return `<section class="jr-payment-panel"><div class="jr-payment-icon">${jrIcon('wallet')}</div><h3>${state}</h3><p>Актуальная сумма, доступные способы и история — в форме оплаты.</p>${record && !record.deleted && record.attendance !== -1 ? '<button type="button" class="btn btn-sec" id="jrPaymentOpen">Оплата визита</button>' : jrStub('Детали оплаты','wallet','jr-stub-inline')}</section>`;
}
function jrStatusBar(record, canEdit = false) {
  if (record?.deleted) return '<div class="jr-status-bar"><span class="jr-state-pill is-current">Запись удалена</span></div>';
  const current = record ? record.attendance : 0;
  const states = [[0,'Ожидание','clock'],[1,'Пришёл','plus'],[-1,'Не пришёл','list'],[2,'Подтвердил','check']];
  return `<div class="jr-status-bar" aria-label="Статус визита">${states.map(([value,label,icon]) => {
    if (value === current && !canEdit) return `<span class="jr-state-pill is-current" aria-current="true">${jrIcon(icon)}${label}</span>`;
    if (canEdit) return `<button type="button" data-attendance="${value}" class="jr-state-pill${value === current ? ' is-current' : ''}">${jrIcon(icon)}${label}</button>`;
    if (jrSyncing(record)) return `<button type="button" class="jr-state-pill" disabled title="Изменения передаются в YClients">${jrIcon(icon)}${label}</button>`;
    if (record?.paid) return `<button type="button" class="jr-state-pill" disabled title="Сначала удалите оплаты визита">${jrIcon(icon)}${label}</button>`;
    return jrStub(label,icon,'jr-state-pill');
  }).join('')}</div>`;
}
// editable: the lines themselves open the editor (a separate button alone
// looked like a read-only list — 10.11.2026).
function jrServicesPanel(record, editable = false) {
  const tag = editable ? 'button type="button" data-service-line' : 'div';
  const end = editable ? 'button' : 'div';
  return `<section class="jr-service-panel"><div class="jr-service-tabs"><span class="is-active">${jrIcon('list')} Услуги</span>${jrStub('Товары','box','jr-tab-stub')}</div>
    <div class="jr-service-lines">${(record.services || []).map(s => `<${tag} class="jr-service-line"${editable ? ' title="Изменить количество и стоимость"' : ''}><span>${jrEscape(s.title || 'Услуга')}${Number(s.quantity) > 1 ? ` <small>× ${jrEscape(s.quantity)} по ${jrEscape(Number(s.unitPrice || 0).toLocaleString('ru'))} ₽</small>` : ''}</span><strong>${jrEscape(Number(s.cost || 0).toLocaleString('ru'))} ₽</strong></${end}>`).join('') || '<p>Услуги не указаны</p>'}</div>
    <p class="jr-hint">Длительность визита при изменении услуг сохраняется.</p></section>`;
}
// Outbox package that could not be delivered to YClients: reason + safe next steps.
function jrSyncAlert(record) {
  const sync = record?.sync;
  if (sync?.status !== 'failed') return '';
  const uncertain = sync.errorCode === 'uncertain';
  return `<div class="jr-sync-alert" role="alert"><strong>Не передано в YClients: ${jrEscape(sync.errorText || 'причина неизвестна')}</strong>${uncertain ? '<p>Нужна сверка в YClients — владелец: кнопка «Сверка операций».</p>' : ''}<div class="jr-actions">${uncertain ? '' : '<button type="button" class="btn btn-sec" id="jrSyncRetry">Повторить отправку</button>'}${uncertain ? '' : `<button type="button" class="btn btn-sec" id="jrSyncDismiss">${Number(record.id) < 0 ? 'Убрать из журнала' : 'Отменить неотправленные изменения'}</button>`}</div></div>`;
}
// A record whose changes are only saved locally stays editable (also a new
// record not yet in YClients); a package on its way or failed locks it.
const jrLocked = record => jrSyncing(record) || record.sync?.status === 'failed';
const jrCanChange = record => !record.deleted && !record.paid && !jrLocked(record);
const jrCanEdit = record => !record.deleted && record.attendance !== -1 && record.attendance !== 1 && !record.paid && !jrLocked(record);
function jrAppointmentCard(record) {
  const canEdit = jrCanEdit(record);
  const local = Number(record.id) < 0;
  const editNote = jrSyncing(record) ? 'Изменения передаются в YClients' : record.sync?.status === 'failed' ? 'Сначала повторите или отмените неотправленные изменения.'
    : jrCanChange(record) ? `Перенос и отмена недоступны для визита со статусом «${record.attendance === 1 ? 'Пришёл' : 'Не пришёл'}». Статус, услуги и стоимость можно менять.`
    : 'Изменения этого визита выполняются в YClients.';
  const staffName = journal.data?.staff?.find(s => s.id === record.staffId)?.name || record.staffName || 'Сотрудник';
  const initials = staffName.split(/\s+/).slice(0,2).map(s => s[0] || '').join('');
  const day = record.date ? new Date(record.date + 'T12:00:00+03:00').toLocaleDateString('ru', { day:'numeric',month:'long',timeZone:'Europe/Moscow' }) : 'Дата не указана';
  return `${jrSyncAlert(record)}<div class="jr-booking-layout"><aside class="jr-booking-side"><div class="jr-visit-summary"><div class="jr-staff-identity"><span class="jr-staff-avatar">${jrEscape(initials)}</span><div><strong>${jrEscape(staffName)}</strong><small>Специалист</small></div></div><div class="jr-visit-date">${jrIcon('calendar')}<div><strong>${jrEscape(day)}</strong><small>${jrEscape(record.time)} · ${jrEscape(record.duration)} мин.</small></div></div>${canEdit ? `<button type="button" class="btn btn-sec jr-move-btn" id="jrMove">${jrIcon('move')}Перенести запись</button>` : `<button type="button" class="btn btn-sec jr-move-btn" disabled title="${jrEscape(editNote)}">Перенести запись</button>`}</div>
    <label class="jr-side-label">Комментарий к записи<textarea rows="4" readonly placeholder="Комментарий не указан">${jrEscape(record.comment || '')}</textarea><small>Редактирование — скоро</small></label>${record ? jrTools() : '<div class="jr-tools">' + [['Расширенные поля','list'],['Повторение записи','repeat'],['Уведомления о визите','bell']].map(([label,icon]) => jrStub(label,icon)).join('') + '</div>'}</aside>
    <section class="jr-booking-main jr-booking-panel">${jrStatusBar(record,jrCanChange(record))}${jrSyncing(record) ? '<p class="jr-hint" role="status">Передаём изменения в YClients… Карточка обновится автоматически.</p>' : jrUnsent(record) ? `<p class="jr-hint jr-unsent-hint" role="status">${local ? 'Новая запись сохранена в журнале' : 'Изменения сохранены в журнале'} и ещё не отправлены в YClients — кнопка «Отправить в YClients» над журналом.</p>` : ''}${jrServicesPanel(record, jrCanChange(record))}${jrCanChange(record) ? '<button type="button" class="btn btn-sec" id="jrEditServices">Изменить услуги, количество и стоимость</button>' : record.paid && !record.deleted ? '<p class="jr-hint">Визит оплачен: чтобы изменить статус, услуги или стоимость, сначала удалите оплаты в «Оплата визита».</p>' : ''}${jrPaymentPanel(record)}${!canEdit ? `<p class="jr-hint">${jrEscape(editNote)}</p>` : ''}</section>${jrClientPanel(record)}</div>
    <footer class="jr-booking-footer"><span class="jr-hint">Изменения сохраняются в журнале кнопкой «Сохранить изменения» (при закрытии карточки спросим); в YClients они уходят по кнопке «Отправить в YClients».</span><div>${canEdit ? '<button type="button" class="btn btn-sec" id="jrCancel">Отменить запись</button>' : ''}${jrStub('Удалить запись','file','jr-stub-inline')}${jrCanChange(record) ? '<button type="button" class="btn btn-pri" id="jrSaveChanges" disabled>Сохранить изменения</button>' : jrStub('Сохранить изменения','check','jr-stub-inline')}</div></footer>`;
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
  return !!(s?.edit || (journal.payment && s && (s.create || s.payments?.length || s.removePayments?.length)));
}
// What would be lost by closing now; null = nothing unsaved.
function jrUnsavedKind() {
  if (journal.payment) return jrSessionPending() ? 'payment' : null;
  const apply = jrEl('jrApply'), applyReady = !!(jrEl('jrForm') && apply && !apply.disabled);
  if (journal.draft?.action === 'move') return applyReady || journal.session?.edit ? 'move' : null;
  if (journal.draft?.action === 'create') return journal.formTouched ? (applyReady ? 'create' : 'create-incomplete') : null;
  if (journal.session?.edit) return 'edit';
  return null;
}
function jrHideCloseAsk() {
  const box = jrEl('jrCloseAsk');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  journal.closeAsk = false;
}
// Closing with unsaved changes (11.11.2026): the user chooses — save, discard
// or keep editing. Before, closing the card/move form saved silently.
function jrAskClose(kind) {
  const box = jrEl('jrCloseAsk');
  if (!box) return;
  const canSave = kind !== 'create-incomplete';
  journal.closeAsk = true;
  box.hidden = false;
  box.innerHTML = `<p><strong>${kind === 'create' || kind === 'create-incomplete' ? 'Запись ещё не создана.' : 'Есть несохранённые изменения.'}</strong> ${canSave ? 'Сохранить их перед закрытием?' : 'Заполнены не все поля — закрыть без сохранения?'}</p><div class="jr-actions">${canSave ? `<button type="button" class="btn btn-pri" id="jrCloseSave">${kind === 'create' ? 'Создать запись' : 'Сохранить'}</button>` : ''}<button type="button" class="btn btn-sec" id="jrCloseDiscard">Закрыть без сохранения</button><button type="button" class="btn btn-sec" id="jrCloseStay">Продолжить редактирование</button></div>`;
  if (canSave) jrEl('jrCloseSave').onclick = () => {
    jrHideCloseAsk();
    const form = jrEl('jrForm'), apply = jrEl('jrApply');
    if ((kind === 'move' || kind === 'create') && form && apply && !apply.disabled) { journal.payAfterCreate = null; return form.requestSubmit(); }
    return jrSave(jrSessionBody());
  };
  jrEl('jrCloseDiscard').onclick = () => jrClose(true);
  jrEl('jrCloseStay').onclick = jrHideCloseAsk;
}
function jrClose(force) {
  if (journal.busy) return;
  if (force !== true) {
    if (journal.closeAsk) { jrHideCloseAsk(); return; }
    const kind = jrUnsavedKind();
    if (kind) return jrAskClose(kind);
  }
  jrHideCloseAsk();
  jrStopRecordWatch();
  journal.modalRequest++; journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null; journal.formTouched = false;
  jrEl('jrModal').close();
}
function jrMessage(message) { jrEl('jrModalError').textContent = message; }
async function jrOpen(id) {
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null;
  jrShowModal('Карточка записи', true);
  try {
    const r = await jrApi('records/' + id);
    if (request !== journal.modalRequest) return;
    jrRenderRecord(r);
    if (jrSyncing(r)) jrWatchRecord(r.id);

  } catch (e) { if (request === journal.modalRequest) jrMessage(e.message); }
}
function jrRenderRecord(r) {
    const canEdit = jrCanEdit(r);
    jrEl('jrModalBody').innerHTML = jrAppointmentCard(r);
    jrSetCardStatus(r.deleted ? null : r.attendance);
    if (jrEl('jrModal')?.dataset) { if (r.paidFull) jrEl('jrModal').dataset.paidFull = '1'; else delete jrEl('jrModal').dataset.paidFull; }
    if (!r.deleted && r.attendance !== -1) jrEl('jrPaymentOpen').onclick = () => jrPayFromCard(r.id);
    if (r.sync?.status === 'failed') {
      if (r.sync.errorCode !== 'uncertain') jrEl('jrSyncRetry').onclick = () => jrSyncAction(r.sync.outboxId, 'retry');
      if (r.sync.errorCode !== 'uncertain') jrEl('jrSyncDismiss').onclick = () => jrSyncAction(r.sync.outboxId, 'dismiss');
    }
    if (jrCanChange(r)) jrBindRecordEdit(r);
    if (canEdit) {
      jrEl('jrMove').onclick = () => jrForm(r, { carry: journal.session?.edit ? { edit: journal.session.edit, servicesVersion: journal.session.servicesVersion } : null });

      jrEl('jrCancel').onclick = () => jrConfirmAction(r, 'cancel');
    }
}
// The card is tinted by the visit status (like the block in the grid) and
// follows a status click at once, before saving.
function jrSetCardStatus(attendance) {
  const modal = jrEl('jrModal');
  if (!modal?.dataset) return;
  if (attendance === null || attendance === undefined) delete modal.dataset.status;
  else modal.dataset.status = String(attendance);
}
function jrStopRecordWatch() {
  clearTimeout(journal.cardTimer);
  journal.cardTimer = null;
  journal.cardWatch = null;
}
function jrWatchRecord(id) {
  jrStopRecordWatch();
  const watch = { id, request: journal.modalRequest };
  journal.cardWatch = watch;
  const current = () => journal.cardWatch === watch && journal.modalRequest === watch.request && jrEl('jrModal').open;
  const schedule = () => { journal.cardTimer = setTimeout(refresh, 2000); };
  const refresh = async () => {
    journal.cardTimer = null;
    if (!current()) return;
    if (document.hidden || journal.busy) { schedule(); return; }
    try {
      const record = await jrApi('records/' + id);
      if (!current()) return;
      jrRenderRecord(record);
      if (!jrSyncing(record)) { jrStopRecordWatch(); return; }
    } catch (_) {
      // A transient read failure must not permanently freeze the open card.
      if (!current()) return;
    }
    schedule();
  };
  schedule();
}
async function jrSyncAction(outboxId, action) {
  let ok = false;
  await jrWithBusy(action === 'retry' ? 'Отправляем повторно…' : 'Убираем…', async () => {
    try { await jrApi(`sessions/${encodeURIComponent(outboxId)}/${action}`, {}); ok = true; }
    catch (e) { jrMessage(e.message); }
  });
  if (!ok) return false;
  jrMessage(''); jrClose(true); loadJournal({ silent: true });
  return true;
}
function jrConfirmAction(r, action) {
  jrShowModal(action === 'cancel' ? 'Отменить запись' : 'Подтвердить запись');
  journal.draft = { action, recordId: r.id };
  journal.session = jrNewSession({ recordId: r.id });
  journal.payment = null;
  jrEl('jrModalBody').innerHTML = `<p>${jrEscape(r.clientName)} · ${jrEscape(r.date)} ${jrEscape(r.time)}</p><p>${action === 'cancel' ? 'Отменить визит? В YClients будет установлен статус «Не пришёл», длительность сократится до 5 минут. Это текущий способ отмены в LoyalPro.' : 'Подтвердить запись?'}</p><div class="jr-actions"><button class="btn btn-pri" id="jrApply">${action === 'cancel' ? 'Да, отменить запись' : 'Подтвердить запись'}</button><button class="btn btn-sec" id="jrBack">Назад</button></div>`;
  jrEl('jrApply').onclick = () => jrSave({ sessionId: journal.session.sessionId, recordId: r.id, status: action });
  jrEl('jrBack').onclick = () => jrOpen(r.id);
}
function jrCreateClientPanel() {
  return `<aside class="jr-booking-client jr-booking-panel jr-create-client"><div class="jr-fields">
    <label>Найти клиента<input id="jrClientSearch" type="search" placeholder="Имя или телефон" autocomplete="off"></label>
    <button type="button" class="btn btn-sec" id="jrClearClient" hidden>Другой / новый клиент</button>
    <label>Фамилия<input id="jrSurname" maxlength="60" autocomplete="off" placeholder="Фамилия"></label>
    <label>Имя<input id="jrName" required maxlength="120" autocomplete="off" placeholder="Имя"></label>
    <label>Отчество<input id="jrPatronymic" maxlength="60" autocomplete="off" placeholder="Отчество"></label>
    <label>Телефон<input id="jrPhone" required type="tel" maxlength="24" autocomplete="off" placeholder="+7 …"></label>
    <label>Email<input id="jrEmail" type="email" readonly placeholder="Из карточки выбранного клиента"><small>Редактирование — в разделе «Клиенты»</small></label>
    </div><label class="jr-other-visitor"><input type="checkbox" disabled> Записывает другого посетителя <small>Скоро</small></label>
    <div id="jrClientSummary" class="jr-hint"></div><h4 id="jrClientsTitle">Последние клиенты</h4><div id="jrClientResults" aria-live="polite"></div></aside>`;
}
async function jrLoadClients(query = '') {
  const modal = journal.modalRequest;
  const request = journal.clientRequest = (journal.clientRequest || 0) + 1;
  jrEl('jrClientResults').textContent = 'Загрузка…';
  try {
    const response = await fetch('/api/clients?' + new URLSearchParams({search:query,limit:'6',sort:'last_visit_at',sort_dir:'desc'}), {headers:{Authorization:'Bearer ' + TOKEN},cache:'no-store'});
    if (!response.ok) throw new Error('Клиенты недоступны');
    const result = await response.json();
    if (modal !== journal.modalRequest || request !== journal.clientRequest) return;
    journal.clientResults = result.clients || [];
    jrEl('jrClientsTitle').textContent = query ? 'Найденные клиенты' : 'Последние клиенты';
    jrEl('jrClientResults').innerHTML = journal.clientResults.length ? journal.clientResults.map((c,i) => `<button type="button" class="jr-client-result" data-client-index="${i}"><span>${jrEscape(c.name || 'Без имени')}</span><small>${jrEscape(c.phone || 'Нет телефона')}</small></button>`).join('') : '<p class="jr-hint">Клиенты не найдены. Заполните данные нового клиента.</p>';
    jrEl('jrClientResults').querySelectorAll('[data-client-index]').forEach(button => { button.onclick = () => jrSelectClient(journal.clientResults[Number(button.dataset.clientIndex)]); });
  } catch (_) {
    if (modal === journal.modalRequest && request === journal.clientRequest) jrEl('jrClientResults').textContent = 'Не удалось загрузить клиентов. Повторите поиск.';
  }
}
function jrSelectClient(client) {
  journal.selectedClient = client || null;
  // Local names may already contain the full name. Preserve that exact value
  // when submitting: POST /records can rename the upstream client by phone.
  const parts = client ? String(client.name || '').trim().split(/\s+/) : [];
  const split = parts.length === 3;
  jrEl('jrSurname').value = split ? parts[0] : '';
  jrEl('jrName').value = split ? parts[1] : client?.name || '';
  jrEl('jrPatronymic').value = split ? parts[2] : '';
  jrEl('jrPhone').value = client?.phone || '';
  jrEl('jrEmail').value = client?.email || '';
  ['jrSurname','jrName','jrPatronymic','jrPhone'].forEach(id => { jrEl(id).readOnly = !!client; });
  jrEl('jrPhone').readOnly = !!client?.phone;
  jrEl('jrClearClient').hidden = !client;
  jrEl('jrClientSummary').textContent = client ? `Визитов: ${Number(client.visits_count) || 0} · Бонусы: ${Number(client.bonus_balance) || 0}. Данные из карточки LoyalPro.` : '';
}
function jrServiceMeta(service) {
  const specific = service.staffDetails?.find(s => s.id === Number(jrEl('jrStaff').value));
  const duration = specific?.duration || service.duration;
  const price = specific?.priceMin ?? service.priceMin;
  const max = specific?.priceMax ?? service.priceMax;
  return [duration ? duration + ' мин' : '', price != null ? (max > price ? 'от ' : '') + Number(price).toLocaleString('ru-RU') + ' ₽' : 'Цена не указана'].filter(Boolean).join(' · ');
}
function jrLineCalculation(line) {
  const quantity = Number(line.quantity), price = Number(line.unitPrice), discount = Number(line.discount);
  if (line.unitPrice === '' || !Number.isFinite(price) || price < 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return null;
  const gross = Math.round(price * 100) * quantity;
  const total = line.mode === 'total' ? Math.round(Number(line.total) * 100) : Math.round(gross * (10000 - Math.round(discount * 100)) / 10000);
  if (!Number.isFinite(total) || total < 0 || total > gross || (line.mode !== 'total' && (discount < 0 || discount > 100))) return null;
  return {gross:gross/100,total:total/100,discount:gross?Math.round((gross-total)/gross*10000)/100:0};
}
function jrSelectedLines() {
  return Array.from(jrEl('jrServices').selectedOptions).map(o => journal.lines?.[o.value]).filter(Boolean);
}
function jrLineEditors(choices, selected) {
  journal.lines ||= {};
  const rows = choices.filter(s => selected.has(s.id));
  for (const s of rows) if (!journal.lines[s.id]) {
    const price=s.staffDetails?.find(x=>x.id===Number(jrEl('jrStaff').value))?.priceMin ?? s.priceMin;
    journal.lines[s.id]={serviceId:s.id,quantity:1,unitPrice:price ?? '',discount:0,total:price ?? '',mode:'discount'};
  }
  jrEl('jrServiceSelection').innerHTML = rows.map(s => {
    const line=journal.lines[s.id], calc=jrLineCalculation(line);
    return `<section class="jr-line-editor"><div class="jr-line-heading"><strong>${jrEscape(s.title)}</strong><button type="button" data-remove-service="${s.id}" aria-label="Удалить услугу">×</button></div><div class="jr-line-fields"><label>Кол-во<input type="number" min="1" max="100" step="1" required data-line="${s.id}" data-field="quantity" value="${line.quantity}"></label><label>Цена, ₽<input type="number" min="0" max="1000000000" step="0.01" required data-line="${s.id}" data-field="unitPrice" value="${jrEscape(line.unitPrice)}"></label><label>Скидка, %<input type="number" min="0" max="100" step="0.01" required data-line="${s.id}" data-field="discount" value="${line.mode==='total' ? calc?.discount ?? 0 : line.discount}"></label><label>Итого, ₽<input type="number" min="0" step="0.01" required data-line="${s.id}" data-field="total" value="${calc?.total ?? ''}"></label></div>${calc ? '' : '<p class="jr-hint">Проверьте цену, количество и скидку.</p>'}</section>`;
  }).join('');
  jrEl('jrServiceSelection').querySelectorAll('[data-line]').forEach(input => {input.onchange=()=>{
    const line=journal.lines[input.dataset.line],field=input.dataset.field;
    const previousDiscount=line.mode==='total' ? jrLineCalculation(line)?.discount ?? 0 : Number(line.discount)||0;
    line[field]=input.value===''?'':Number(input.value);
    if(field==='total')line.mode='total';
    else {line.mode='discount';line.discount=field==='discount'?Number(input.value):previousDiscount;}
    if(field==='quantity')jrEl('jrServices').onchange();
    else jrRenderServiceChoices();
  };});
  jrEl('jrServiceSelection').querySelectorAll('[data-remove-service]').forEach(button=>{button.onclick=()=>{
    const option=Array.from(jrEl('jrServices').options).find(o=>Number(o.value)===Number(button.dataset.removeService));
    if(option){option.selected=false;delete journal.lines[button.dataset.removeService];jrEl('jrServices').onchange();}
  };});
  jrUpdateBill();
}
function jrUpdateBill() {
  const lines=jrSelectedLines(), totals=lines.map(jrLineCalculation);
  const total=totals.every(Boolean)?totals.reduce((sum,l)=>sum+Math.round(l.total*100),0)/100:null;
  if(jrEl('jrBillTotal'))jrEl('jrBillTotal').textContent=total===null?'Проверьте стоимость':Number(total).toLocaleString('ru-RU')+' ₽';
}
function jrCreatePaymentPanel() {
  return `<section class="jr-create-payment"><div class="jr-bill-total">К оплате <strong id="jrBillTotal">0 ₽</strong></div><p class="jr-hint">Выберите способ — запись и оплата сохранятся вместе по кнопке «Готово».</p><div class="jr-pay-shortcuts"><button type="button" class="btn btn-sec" data-pay-next="card">Карта</button><button type="button" class="btn btn-sec" data-pay-next="cash">Наличные</button><button type="button" class="btn btn-sec" data-pay-next="all">Все способы / бонусы</button></div></section>`;
}
function jrServiceCategoryTree(choices, tile, query, expanded = new Set()) {
  const nodes = new Map((journal.data.categories || []).map(c => [Number(c.id), { ...c, children: [], services: [] }]));
  const roots = [], uncategorized = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(Number(node.parent_id));
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  for (const service of choices) {
    const node = nodes.get(Number(service.categoryId));
    const names = [service.title], seen = new Set();
    let ancestor = node;
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id); names.push(ancestor.title);
      ancestor = nodes.get(Number(ancestor.parent_id));
    }
    if (query && !names.some(name => String(name).toLowerCase().includes(query))) continue;
    (node ? node.services : uncategorized).push(service);
  }
  const visited = new Set();
  const render = node => {
    if (visited.has(node.id)) return '';
    visited.add(node.id);
    const children = node.children.map(render).join('');
    if (!node.services.length && !children) return '';
    return `<details class="jr-service-category" data-category-id="${Number(node.id)}"${query || expanded.has(String(node.id)) ? ' open' : ''}><summary>${jrEscape(node.title)}</summary><div class="jr-category-content">${node.services.length ? '<div class="jr-service-choices">' + node.services.map(tile).join('') + '</div>' : ''}${children}</div></details>`;
  };
  let html = roots.map(render).join('');
  // Defensive handling of malformed category graphs keeps services reachable.
  for (const node of nodes.values()) if (!visited.has(node.id)) html += render(node);
  if (uncategorized.length) html += `<section class="jr-uncategorized"><h4>Без категории</h4><div class="jr-service-choices">${uncategorized.map(tile).join('')}</div></section>`;
  return html || '<p class="jr-hint">Нет подходящих услуг у выбранного специалиста.</p>';
}
function jrRenderServiceChoices() {
  const selected = new Set(Array.from(jrEl('jrServices').selectedOptions).map(o => Number(o.value)));
  const query = jrEl('jrServiceSearch').value.trim().toLowerCase();
  const choices = journal.data.services.filter(s => s.staffIds.includes(Number(jrEl('jrStaff').value)));
  const tile = s => `<button type="button" class="jr-service-choice${selected.has(s.id) ? ' is-selected' : ''}" data-service-id="${s.id}" aria-pressed="${selected.has(s.id)}"><span>${jrEscape(s.title)}</span><small>${jrEscape(jrServiceMeta(s))}</small>${selected.has(s.id) ? '<b>✓ Выбрано</b>' : ''}</button>`;
  jrEl('jrQuickServices').innerHTML = (query ? choices.filter(s => s.title.toLowerCase().includes(query)) : choices.slice(0,3)).map(tile).join('') || '<p class="jr-hint">Услуги не найдены</p>';
  const expanded = new Set(Array.from(jrEl('jrAllServices').querySelectorAll('details[open]')).map(node => node.dataset.categoryId));
  jrEl('jrAllServices').innerHTML = jrServiceCategoryTree(choices, tile, query, expanded);
  jrLineEditors(choices, selected);
  jrEl('jrModalBody').querySelectorAll('[data-service-id]').forEach(button => { button.onclick = () => {
    const option = Array.from(jrEl('jrServices').options).find(o => Number(o.value) === Number(button.dataset.serviceId));
    if (option) { option.selected = !option.selected; jrEl('jrServices').onchange(); }
  }; });
}
function jrUpdateEndTime() {
  jrEl('jrDuration').value = journal.duration ? journal.duration + ' мин' : 'По выбранным услугам';
  const time = jrEl('jrTime').value;
  jrEl('jrEndTime').value = time && journal.duration ? jrTimeLabel(jrMinutes(time) + journal.duration) : '—';
}
function jrForm(record, preset = {}) {
  if (!journal.data) return;
  journal.modalRequest++; journal.slotRequest++;
  journal.slots = []; journal.duration = null; journal.selectedClient = null; journal.lines = {}; journal.payAfterCreate = null;
  journal.preferredTime = preset.time || null;
  journal.draft = { action: record ? 'move' : 'create', ...(record ? { recordId: record.id } : {}) };
  journal.session = record ? jrNewSession({ recordId: record.id, ...(preset.carry || {}) }) : jrNewSession({ create: null, payments: [] });
  journal.payment = null;
  jrShowModal(record ? 'Перенести запись' : 'Новая запись', true);
  jrEl('jrModalBody').innerHTML = `<form id="jrForm"><div class="jr-booking-layout"><aside class="jr-booking-side"><div class="jr-visit-summary jr-fields"><label>${jrIcon('user')} Сотрудник<select id="jrStaff" required><option value="">Выберите сотрудника</option>${journal.data.staff.map(s => `<option value="${s.id}">${jrEscape(s.name)}</option>`).join('')}</select></label><label>${jrIcon('calendar')} Дата<input id="jrFormDate" type="date" required min="${jrToday()}"></label><label>${jrIcon('clock')} Начало визита<select id="jrTime" required disabled><option value="">Выберите услуги</option></select></label><label>Окончание<input id="jrEndTime" readonly value="—"></label><label>Длительность<input id="jrDuration" readonly value="По выбранным услугам"></label><button type="button" class="btn btn-sec" id="jrFindSlots">Показать свободное время</button><p id="jrSlotInfo" class="jr-hint" role="status"></p>${record ? '' : jrStub('Технический перерыв','plus','jr-stub-inline')}</div>
    ${record ? `<label class="jr-side-label">Комментарий к записи<textarea readonly rows="3">${jrEscape(record.comment || '')}</textarea></label>` : '<label class="jr-side-label">Комментарий к записи<textarea id="jrComment" maxlength="1000" rows="3" placeholder="Добавить комментарий"></textarea></label>'}${record ? jrTools() : '<div class="jr-tools">' + [['Расширенные поля','list'],['Повторение записи','repeat'],['Уведомления о визите','bell']].map(([label,icon]) => jrStub(label,icon)).join('') + '</div>'}</aside>
    <section class="jr-booking-main jr-booking-panel">${jrStatusBar(record && preset.carry?.edit?.attendance !== undefined ? { ...record, attendance: preset.carry.edit.attendance } : record)}${record && preset.carry?.edit ? '<p class="jr-hint" role="status">Изменения статуса и услуг из карточки сохранятся вместе с переносом.</p>' : ''}${record ? jrServicesPanel(record) : `<div id="jrServiceSelection" class="jr-selected-services" aria-live="polite"></div><section class="jr-service-panel"><div class="jr-service-tabs"><span class="is-active">${jrIcon('list')} Услуги</span>${jrStub('Товары','box','jr-tab-stub')}</div><label class="jr-service-search">Поиск по услугам<input id="jrServiceSearch" type="search" placeholder="Название услуги" autocomplete="off"></label><select id="jrServices" multiple hidden aria-label="Выбранные услуги"></select><p id="jrServicesHint" class="jr-hint">Услуги специалиста · нажмите, чтобы выбрать</p><div id="jrQuickServices" class="jr-service-choices"></div><details class="jr-all-services"><summary>Все услуги</summary><div id="jrAllServices" class="jr-service-tree"></div></details></section>`}${record ? jrPaymentPanel(record) : jrCreatePaymentPanel()}</section>${record ? jrClientPanel(record) : jrCreateClientPanel()}</div>
    <footer class="jr-booking-footer"><span class="jr-hint">Изменения передаются в YClients в фоне.</span><div><button type="button" class="btn btn-sec" id="jrFormClose">Закрыть</button><button type="submit" class="btn btn-pri" id="jrApply" disabled>${record ? 'Сохранить перенос' : 'Создать запись'}</button></div></footer></form>`;
  jrEl('jrFormClose').onclick = jrClose;
  journal.formTouched = false;
  { const form = jrEl('jrForm'); if (form?.addEventListener) {
    const touch = () => { journal.formTouched = true; };
    form.addEventListener('input', touch); form.addEventListener('change', touch);
    form.addEventListener('click', e => { if (e.target?.closest?.('[data-service-id],.jr-client-result,.jr-state-pill')) touch(); });
  } }
  jrEl('jrApply').onclick = () => { journal.payAfterCreate = null; };
  jrEl('jrModalBody').querySelectorAll('[data-pay-next]').forEach(button=>{button.onclick=()=>{
    if(!journal.slots.includes(jrEl('jrTime').value)){jrMessage('Сначала выберите услуги и свободное время.');return;}
    journal.payAfterCreate=button.dataset.payNext;
    jrEl('jrForm').requestSubmit();
  };});
  jrEl('jrFormDate').value = record?.date || preset.date || jrEl('jrDate').value;
  jrEl('jrStaff').value = String(record?.staffId || preset.staffId || jrEl('jrStaffFilter').value || '');
  const invalidate = () => { journal.slotRequest++; journal.slots = []; jrEl('jrTime').innerHTML = '<option value="">Проверьте свободное время</option>'; jrEl('jrTime').disabled = true; jrEl('jrApply').disabled = true; jrEl('jrSlotInfo').textContent = ''; journal.duration = null; jrUpdateEndTime(); };
  const services = () => {
    if (record) return;
    const staffId = Number(jrEl('jrStaff').value);
    journal.lines = {};
    jrEl('jrServiceSearch').value = '';
    jrEl('jrServiceSelection').textContent = '';
    jrEl('jrServices').innerHTML = journal.data.services.filter(s => s.staffIds.includes(staffId)).map(s => `<option value="${s.id}">${jrEscape(s.title)}${s.duration ? ' · ' + s.duration + ' мин.' : ''}</option>`).join('');
    jrRenderServiceChoices();
    if (!jrEl('jrServices').options.length) jrEl('jrSlotInfo').textContent = 'У сотрудника нет доступных услуг. Проверьте раздел «Услуги» и импорт каталога.';
  };
  services();
  if (journal.preferredTime) {
    jrEl('jrTime').innerHTML = `<option value="">${jrEscape(journal.preferredTime)} — проверим после выбора услуг</option>`;
    jrEl('jrSlotInfo').textContent = 'Выберите услуги: проверим выбранное время и длительность визита.';
  }
  jrEl('jrStaff').onchange = () => { journal.preferredTime = null; invalidate(); services(); };
  jrEl('jrFormDate').onchange = () => { journal.preferredTime = null; invalidate(); };
  if (!record) {
    jrEl('jrServiceSearch').oninput = jrRenderServiceChoices;
    jrEl('jrServices').onchange = () => {
      if (jrEl('jrTime').value) journal.preferredTime = jrEl('jrTime').value;
      invalidate(); jrRenderServiceChoices();
      if (jrEl('jrServices').selectedOptions.length) jrFindSlots();
    };
    jrEl('jrClientSearch').oninput = () => jrLoadClients(jrEl('jrClientSearch').value.trim());
    jrEl('jrClearClient').onclick = () => jrSelectClient(null);
    jrLoadClients();
  }
  jrEl('jrTime').onchange = () => { jrEl('jrApply').disabled = !journal.slots.includes(jrEl('jrTime').value); jrUpdateEndTime(); };
  jrEl('jrFindSlots').onclick = jrFindSlots;
  jrEl('jrForm').onsubmit = e => {
    e.preventDefault();
    const session = journal.session;
    if (!session) return;
    const draft = jrFormDraft(record);
    if (!record && journal.payAfterCreate) return jrCreateWithPayment(draft, journal.payAfterCreate);
    return jrSave(record ? { sessionId: session.sessionId, recordId: record.id, move: draft, ...(session.edit ? { edit: { ...session.edit, ...(session.servicesVersion ? { servicesVersion: session.servicesVersion } : {}) } } : {}) } : { sessionId: session.sessionId, create: draft });
  };
}
function jrFormDraft(record) {
  const draft = { date: jrEl('jrFormDate').value, time: jrEl('jrTime').value, staffId: Number(jrEl('jrStaff').value) };
  if (!record) Object.assign(draft, { serviceSource: journal.data.serviceSource, ...(journal.data.serviceSource === 'internal' ? {lines:jrSelectedLines()} : {}), serviceIds: Array.from(jrEl('jrServices').selectedOptions).map(o => Number(o.value)), clientName: journal.selectedClient?.name || [jrEl('jrSurname').value,jrEl('jrName').value,jrEl('jrPatronymic').value].map(s => s.trim()).filter(Boolean).join(' '), clientPhone: journal.selectedClient?.phone || jrEl('jrPhone').value, comment: jrEl('jrComment').value });
  return draft;
}
async function jrFindSlots() {
  const request = ++journal.slotRequest;
  const params = { date: jrEl('jrFormDate').value, staffId: jrEl('jrStaff').value };
  if (journal.draft.recordId) params.recordId = journal.draft.recordId;
  else params.serviceIds = Array.from(jrEl('jrServices').selectedOptions).map(o => o.value).join(',');
  if (!params.recordId && journal.data.serviceSource) { params.serviceSource = journal.data.serviceSource; params.quantities = Array.from(jrEl('jrServices').selectedOptions).map(o=>journal.lines?.[o.value]?.quantity || 1).join(','); }
  if (!params.staffId || (!params.recordId && !params.serviceIds)) { jrMessage('Выберите сотрудника и услуги.'); return; }
  jrMessage('');
  journal.slots = []; jrEl('jrApply').disabled = true; jrEl('jrTime').disabled = true;
  jrEl('jrSlotInfo').textContent = 'Проверяем график и оборудование…';
  try {
    const result = await jrApi('slots?' + new URLSearchParams(params));
    if (request !== journal.slotRequest) return;
    journal.slots = result.slots; journal.duration = result.duration;
    jrEl('jrTime').innerHTML = '<option value="">Выберите время</option>' + result.slots.map(t => `<option value="${jrEscape(t)}">${jrEscape(t)}</option>`).join('');
    jrEl('jrTime').disabled = !result.slots.length;
    if (journal.preferredTime && result.slots.includes(journal.preferredTime)) {
      jrEl('jrTime').value = journal.preferredTime; jrEl('jrApply').disabled = false;
    }
    jrUpdateEndTime();
    jrEl('jrSlotInfo').textContent = result.slots.length ? `Длительность визита: ${result.duration} мин.` : 'Свободного времени нет. Выберите другой день или сотрудника.';
    if (journal.preferredTime && !result.slots.includes(journal.preferredTime)) jrEl('jrSlotInfo').textContent += ` Выбранное время ${journal.preferredTime} недоступно для этих услуг. Выберите другое время.`;
  } catch (e) { if (request === journal.slotRequest) { jrEl('jrSlotInfo').textContent = ''; jrMessage(e.message); } }
}
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
  return body;
}
// The server only stores the session (fractions of a second); YClients is
// updated in the background, so the form closes as soon as it answers.
async function jrSave(body) {
  let ok = false, used = false;
  await jrWithBusy('Сохраняем…', async () => {
    try { await jrApi('sessions', body); ok = true; }
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
  notify('Сохранено в журнале. В YClients — кнопкой «Отправить в YClients».');
  return true;
}
async function jrCreateWithPayment(draft, preferred) {
  const session = journal.session;
  if (!session) return;
  let options = null;
  await jrWithBusy('Проверяем запись…', async () => {
    try { options = (await jrApi('sessions/validate', { sessionId: session.sessionId, create: draft })).options; }
    catch (e) { jrMessage(e.message); }
  });
  if (!options || journal.session !== session) return;
  session.create = draft; session.payments = []; session.removePayments = [];
  journal.modalRequest++; journal.slotRequest++;
  jrShowModal('Оплата визита', true);
  jrEl('jrModal').className = 'jr-dialog jr-dialog-wide jr-dialog-payment';
  jrPaymentShow(options, { preferred, keepScroll: false });
}
jrEl('jrModal').addEventListener('cancel', event => { event.preventDefault(); jrClose(); });

async function jrReviewPending() {
  const request = ++journal.modalRequest;
  jrShowModal('Сверка операций');
  try {
    const rows = await jrApi('operations/pending');
    if (request !== journal.modalRequest) return;
    if (!rows.length) { jrEl('jrModalBody').textContent = 'Незавершённых операций нет.'; return; }
    jrEl('jrModalBody').innerHTML = '<p>Сначала проверьте в YClients, выполнилось ли действие. Только после сверки снимите блокировку. Снятие блокировки не повторяет действие и не удаляет записи.</p>' + rows.map(r => `<div class="jr-review-row"><p>${jrEscape(({create:'Создание',move:'Перенос',cancel:'Отмена',confirm:'Подтверждение'})[r.action])} · ${jrEscape(new Date(r.created_at).toLocaleString('ru', { timeZone: 'Europe/Moscow' }))}${r.record_id ? ' · запись №' + jrEscape(r.record_id) : ''}</p><label><input type="checkbox" data-check="${jrEscape(r.operation_id)}"> Я проверил результат в YClients</label><button class="btn btn-sec" data-review="${jrEscape(r.operation_id)}" disabled>Сверка завершена, снять блокировку</button></div>`).join('');
    jrEl('jrModalBody').querySelectorAll('[data-check]').forEach(el => { el.onchange = () => {
      jrEl('jrModalBody').querySelector(`[data-review="${el.dataset.check}"]`).disabled = !el.checked;
    }; });
    jrEl('jrModalBody').querySelectorAll('[data-review]').forEach(el => { el.onclick = async () => {
      el.disabled = true;
      try { await jrApi('operations/review', { operationId: el.dataset.review, checkedInYclients: true }); await jrReviewPending(); }
      catch (e) { jrMessage(e.message); el.disabled = false; }
    }; });
  } catch (e) { if (request === journal.modalRequest) jrMessage(e.message); }
}

// «Отправить в YClients»: journal changes wait locally; this sends the records
// whose visit falls into the chosen period (all their waiting changes).
function jrUpdateDispatchButton(unsent) {
  const button = jrEl('jrDispatch');
  if (!button) return;
  journal.unsent = unsent || null;
  const n = Number(unsent?.records) || 0;
  button.textContent = n ? `Отправить в YClients (${n})` : 'Отправить в YClients';
  button.classList.toggle('btn-pri', n > 0);
  button.classList.toggle('btn-sec', !n);
  button.title = n ? `Не отправлено в YClients: записей — ${n}` : 'Все изменения журнала отправлены в YClients';
}
const jrDispatchWord = n => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'запись' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'записи' : 'записей'; };
async function jrDispatchOpen() {
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null;
  jrShowModal('Отправить в YClients');
  let summary = journal.unsent;
  try { summary = await jrApi('dispatch/summary'); } catch (_) { /* keep the day's figure */ }
  if (request !== journal.modalRequest) return;
  jrUpdateDispatchButton(summary);
  const today = jrToday();
  const from = summary?.from || jrEl('jrDate').value || today, to = summary?.to || from;
  jrEl('jrModalBody').innerHTML = `<form id="jrDispatchForm" class="jr-dispatch-form">
    <p>Изменения журнала сохраняются только у нас. Выберите период визитов: в YClients уйдут все неотправленные изменения записей этих дней — новые записи, статусы, услуги, время, специалист и оплаты.</p>
    <p class="jr-hint">${summary?.records ? `Всего не отправлено: ${summary.records} ${jrDispatchWord(summary.records)}${summary.from ? `, визиты с ${jrEscape(summary.from)} по ${jrEscape(summary.to)}` : ''}.` : 'Неотправленных изменений нет.'}</p>
    <div class="jr-dispatch-period"><label>С<input type="date" id="jrDispatchFrom" required value="${jrEscape(from)}"></label><label>По<input type="date" id="jrDispatchTo" required value="${jrEscape(to)}"></label></div>
    <p id="jrDispatchPreview" class="jr-dispatch-preview" role="status" aria-live="polite"></p>
    <div class="jr-actions"><button type="submit" class="btn btn-pri" id="jrDispatchGo" disabled>Отправить</button><button type="button" class="btn btn-sec" onclick="jrClose(true)">Отмена</button></div>
  </form>`;
  let previewRequest = 0;
  const preview = async () => {
    const mine = ++previewRequest, f = jrEl('jrDispatchFrom').value, t = jrEl('jrDispatchTo').value;
    jrEl('jrDispatchGo').disabled = true;
    if (!f || !t) { jrEl('jrDispatchPreview').textContent = 'Укажите обе даты.'; return; }
    jrEl('jrDispatchPreview').textContent = 'Считаем…';
    try {
      const r = await jrApi('dispatch/preview?' + new URLSearchParams({ from: f, to: t }));
      if (mine !== previewRequest || request !== journal.modalRequest) return;
      jrEl('jrDispatchPreview').textContent = r.records ? `Будет отправлено: ${r.records} ${jrDispatchWord(r.records)} (изменений: ${r.packages}).` : 'За этот период отправлять нечего.';
      jrEl('jrDispatchGo').disabled = !r.records;
    } catch (e) { if (mine === previewRequest) jrEl('jrDispatchPreview').textContent = e.message; }
  };
  jrEl('jrDispatchFrom').onchange = preview; jrEl('jrDispatchTo').onchange = preview;
  jrEl('jrDispatchForm').onsubmit = async e => {
    e.preventDefault();
    const f = jrEl('jrDispatchFrom').value, t = jrEl('jrDispatchTo').value;
    let out = null;
    await jrWithBusy('Отправляем…', async () => {
      try { out = await jrApi('dispatch', { from: f, to: t }); } catch (err) { jrMessage(err.message); }
    });
    if (!out || request !== journal.modalRequest) return;
    if (!out.releaseId) { jrEl('jrDispatchPreview').textContent = 'За этот период отправлять нечего.'; return; }
    loadJournal({ silent: true });
    jrDispatchProgress(out, request);
  };
  preview();
}
function jrDispatchProgress(started, request) {
  const body = jrEl('jrModalBody');
  const render = p => {
    const done = p.done + p.cancelled, left = p.queued + p.running;
    body.innerHTML = `<div class="jr-dispatch-progress" role="status" aria-live="polite">
      <p><strong>${p.finished ? (p.failed ? 'Отправка завершена с ошибками' : 'Отправлено в YClients') : 'Отправляем в YClients…'}</strong></p>
      <p>Записей: ${started.records} · изменений: ${p.total}. Готово: ${done}${left ? ` · в очереди: ${left}` : ''}${p.failed ? ` · ошибок: ${p.failed}` : ''}.</p>
      ${p.finished ? '' : '<p class="jr-hint">Окно можно закрыть: отправка продолжится. Записи журнала обновятся сами.</p>'}
      ${p.failures?.length ? `<ul class="jr-dispatch-failures">${p.failures.map(f => `<li><button type="button" class="btn btn-sec" data-open="${jrEscape(f.recordId)}">${jrEscape([f.date, f.clientName].filter(Boolean).join(' · ') || 'Запись')}</button> ${jrEscape(f.errorText || 'причина неизвестна')}</li>`).join('')}</ul><p class="jr-hint">Откройте запись: там можно повторить отправку или отменить неотправленные изменения.</p>` : ''}
      <div class="jr-actions"><button type="button" class="btn btn-sec" onclick="jrClose(true)">Закрыть</button></div></div>`;
    body.querySelectorAll('[data-open]').forEach(el => { el.onclick = () => jrOpen(Number(el.dataset.open)); });
  };
  const tick = async () => {
    if (request !== journal.modalRequest || !jrEl('jrModal').open) return;
    try {
      const p = await jrApi('dispatch/' + encodeURIComponent(started.releaseId));
      if (request !== journal.modalRequest) return;
      render(p);
      if (p.finished) { loadJournal({ silent: true }); return; }
    } catch (e) { jrMessage(e.message); }
    journal.cardTimer = setTimeout(tick, 2000);
  };
  render({ total: started.packages, queued: started.packages, running: 0, done: 0, failed: 0, cancelled: 0, finished: false });
  tick();
}

// Payment form. Choosing methods only edits the session (no server calls);
// «Готово» or confirmed closing sends everything once.
const jrKop = value => Math.round((Number(value) || 0) * 100);
const jrRub = value => Number(value).toLocaleString('ru-RU') + ' ₽';
function jrPaymentView(base, session) {
  const pays = session?.payments || [], removes = session?.removePayments || [];
  const sum = (list, filter = () => true) => list.filter(filter).reduce((n, p) => n + jrKop(p.amount), 0);
  const baseDue = jrKop(base.due);
  const due = Math.max(0, baseDue - sum(pays) + sum(removes));
  const isBonus = p => p.method === 'loyalty_card';
  const bonusNet = sum(pays, isBonus) - sum(removes, isBonus);
  const arrived = pays.some(p => p.confirmArrival === true);
  const methods = (base.methods || []).map(v => {
    if (v.method === 'loyalty_card') {
      const limit = Math.max(0, Math.min(jrKop(v.limit) - bonusNet, due));
      return { ...v, limit: limit / 100, available: limit > 0, unavailableReason: limit > 0 ? null : v.unavailableReason || 'Нет доступных бонусов' };
    }
    // An account was unavailable only because the visit was paid: it reopens when due appears.
    const open = v.available === true || baseDue === 0;
    return { ...v, limit: due / 100, available: open && due > 0, unavailableReason: open && due > 0 ? null : open ? 'Визит оплачен' : v.unavailableReason,
      requiresArrivalConfirmation: v.requiresArrivalConfirmation === true && !arrived };
  });
  return { ...base, due: due / 100, methods };
}
function jrPayTitle(t) {
  if (t.method === 'loyalty_card') return 'Бонусы';
  const m = (journal.payment?.base?.methods || []).find(v => v.method === t.method && Number(v.id) === Number(t.methodId));
  return m ? (m.cash ? 'Наличные' : 'Банковская карта') + ' · ' + m.title : 'Касса';
}
const JR_PAY_STATUS = { confirmed: 'Проведено в YClients', queued: 'Ждёт отправки в YClients', sending: 'Передаётся в YClients', failed: 'Ошибка отправки' };
const jrPayBadge = status => JR_PAY_STATUS[status] ? `<em class="jr-pay-badge jr-pay-badge-${jrEscape(status)}">${jrEscape(JR_PAY_STATUS[status])}</em>` : '';
// Bill lines: «цена × кол-во, скидка −N ₽ (P %)». Old/live responses carry only `total`.
function jrBillItem(i) {
  const detailed = i.unitPrice !== undefined && i.unitPrice !== null;
  const detail = detailed ? `${jrRub(i.unitPrice)} × ${jrEscape(i.quantity)}${Number(i.discount) > 0 ? `, скидка −${jrRub(i.discount)}${Number(i.discountPercent) > 0 ? ` (${jrEscape(i.discountPercent)} %)` : ''}` : ''}` : `×${jrEscape(i.quantity)}`;
  return `<p>${jrEscape(i.title)}<small>${detail}</small><strong>${jrRub(i.total)}</strong></p>`;
}
function jrBillSummary(data, session) {
  const sm = data.summary;
  if (!sm) return '';
  const sum = (list, filter) => (list || []).filter(filter).reduce((n, x) => n + jrKop(x.amount), 0);
  const isBonus = x => x.method === 'loyalty_card';
  const bonusDelta = sum(session?.payments, isBonus) - sum(session?.removePayments, isBonus);
  const bonus = (data.methods || []).find(v => v.method === 'loyalty_card');
  const row = (label, value, cls = '') => `<div class="jr-bill-sum${cls}"><span>${label}</span><strong>${value}</strong></div>`;
  return `<div class="jr-bill-summary">${row('Без скидки', jrRub(sm.gross))}${Number(sm.discount) > 0 ? row('Скидка', '−' + jrRub(sm.discount)) : ''}${row('Итого к оплате за визит', jrRub(sm.total), ' jr-bill-sum-total')}`
    + `${Number(sm.bonusSpent) > 0 || bonusDelta > 0 ? row('Бонусов списано', jrRub((jrKop(sm.bonusSpent) + bonusDelta) / 100)) : ''}`
    + `${bonus && bonus.balanceAfter !== undefined && bonus.balanceAfter !== null ? row('Баланс бонусов после оплаты', jrRub(Math.max(0, jrKop(bonus.balanceAfter) - bonusDelta) / 100)) : ''}</div>`;
}
function jrPaymentBreakdown(data, session, readOnly = false) {
  const removed = new Set((session?.removePayments || []).map(t => t.method + ':' + t.transactionId));
  const real = (data.paid || []).map((t, i) => {
    const gone = removed.has(t.method + ':' + t.id);
    return `<div class="jr-paid-row${gone ? ' jr-pay-queued jr-pay-removed' : ''}"><span>${jrEscape(t.title)}${gone ? '<small>будет удалено</small>' : Array.isArray(data.payments) ? jrPayBadge('confirmed') : ''}</span><strong>${jrRub(t.amount)}</strong>${readOnly ? '' : gone
      ? `<button type="button" data-restore-payment="${i}" title="Не удалять" aria-label="Не удалять транзакцию ${jrEscape(t.title)}">↺</button>`
      : `<button type="button" data-remove-payment="${i}" title="Удалить транзакцию" aria-label="Удалить транзакцию ${jrEscape(t.title)}">${jrIcon('trash')}</button>`}</div>`;
  });
  // Server-side queue (not yet confirmed in YClients): payments and cancellations.
  const server = (Array.isArray(data.payments) ? data.payments : []).filter(t => t.status !== 'confirmed').map(t => {
    const cancel = t.kind === 'remove_payment';
    return `<div class="jr-paid-row jr-pay-queued jr-pay-server${cancel ? ' jr-pay-cancel' : ''}"><span>${cancel ? 'Отмена оплаты · ' : ''}${jrEscape(t.title)}${jrPayBadge(t.status)}</span><strong>${cancel ? '−' : ''}${jrRub(t.amount)}</strong></div>`;
  });
  const queued = (session?.payments || []).map((t, i) => `<div class="jr-paid-row jr-pay-queued"><span>${jrEscape(jrPayTitle(t))}<small>будет передано${t.confirmArrival ? ' · с отметкой прихода' : ''}</small></span><strong>${jrRub(t.amount)}</strong><button type="button" data-drop-payment="${i}" title="Убрать оплату" aria-label="Убрать оплату ${jrEscape(jrPayTitle(t))}">×</button></div>`);
  return `<h4>Оплаты визита</h4>${[...real, ...server, ...queued].join('') || '<p class="jr-hint">Оплат пока нет</p>'}`;
}
function jrPaymentShow(base, opts = {}) {
  const prev = journal.payment;
  const recordId = journal.session?.create ? null : journal.session?.recordId ?? null;
  // A queued create (negative id) is paid like any record (11.11.2026): the
  // server queues the payment package after the create package (create_outbox_id).
  journal.payment = { recordId, base, live: !!opts.live, preferred: opts.preferred || prev?.preferred || 'all', readOnly: false };
  jrRenderPayment(opts.keepScroll !== false);
}
function jrPreferredMethod(v, preferred) {
  if (v.method !== 'account') return false;
  return preferred === 'cash' ? v.cash === true : preferred === 'card' ? v.cash !== true : false;
}
function jrRenderPayment(keepScroll = true) {
  const p = journal.payment, session = journal.session;
  if (!p || !session) return;
  const data = jrPaymentView(p.base, session);
  p.data = data; delete p.arrival;
  const scroll = jrEl('jrModal').scrollTop;
  const dirty = jrSessionPending();
  const preferredIndex = data.methods.findIndex(v => v.available && v.limit && jrPreferredMethod(v, p.preferred));
  const bill = `<aside class="jr-payment-bill"><h3>Общий счёт</h3>${(data.items || []).map(jrBillItem).join('')}${jrBillSummary(data, session)}<div class="jr-bill-total">${data.summary ? 'Остаток к оплате' : 'К оплате'} <strong>${jrRub(data.due)}</strong></div>${jrPaymentBreakdown(data, session, p.readOnly)}`;
  if (p.readOnly) {
    jrEl('jrModalBody').innerHTML = `<div class="jr-payment-layout">${bill}${data.due === 0 ? '<div class="jr-payment-success" role="status">✓ Будет оплачено полностью</div>' : ''}</aside><section class="jr-payment-content"><h3>Оплата визита</h3><p class="jr-hint">Оплата станет доступна после передачи записи в YClients</p><div class="jr-actions"><button type="button" class="btn btn-pri" id="jrPayDone">Готово</button><button type="button" class="btn btn-sec" id="jrPayBack">К записи</button><button type="button" class="btn btn-sec" id="jrPayClose">Закрыть</button></div></section></div>`;
    jrEl('jrModal').scrollTop = keepScroll ? scroll : 0;
    jrEl('jrPayDone').onclick = jrPayDone;
    jrEl('jrPayClose').onclick = () => jrClose();
    jrEl('jrPayBack').onclick = () => jrPayBack(p.recordId);
    return;
  }
  jrEl('jrModalBody').innerHTML = `<div class="jr-payment-layout">${bill}${data.due === 0 ? `<div class="jr-payment-success" role="status">✓ ${dirty ? 'Будет оплачено полностью' : 'Оплачено полностью'}</div>` : ''}</aside><section class="jr-payment-content"><h3>Оплата визита</h3><p class="jr-hint">${data.methods.some(v => v.method === 'account' && v.requiresArrivalConfirmation === true) ? 'Для оплаты наличными или картой потребуется подтвердить фактический приход клиента. Статус визита станет «Пришёл».' : 'Нажмите способ оплаты — сумма добавится к оплате визита.'} Всё выбранное сохранится по кнопке «Готово».</p><label class="jr-partial-payment">Сумма частичной оплаты, ₽ <input id="jrPayPartial" type="number" min="0.01" step="0.01" placeholder="Вся доступная сумма"></label><div class="jr-payment-methods">${data.methods.map((v, i) => `<button type="button" class="jr-pay-method${i === preferredIndex ? ' is-preferred' : ''}" data-method-index="${i}" ${!v.available || !v.limit ? 'disabled' : ''}><strong>${v.method === 'loyalty_card' ? 'Бонусы' : v.cash ? 'Наличные' : 'Банковская карта'}</strong><span>${jrEscape(v.title)}</span><small>${!v.available || !v.limit ? jrEscape(v.unavailableReason || 'Недоступно для оплаты') : 'К оплате ' + jrRub(v.limit)}</small>${v.balance === null || v.balance === undefined ? '' : `<small>Баланс: ${Number(v.balance).toLocaleString('ru-RU')}</small>`}${v.method === 'account' && v.requiresArrivalConfirmation === true ? '<small>Требуется подтверждение прихода</small>' : ''}</button>`).join('') || '<p>Способы оплаты недоступны.</p>'}</div><div id="jrPayArrival" role="group" aria-label="Приход клиента и оплата" aria-live="polite" hidden></div><p class="jr-hint">Для смешанной оплаты сначала нажмите «Бонусы», затем оплатите остаток наличными или картой.</p><div class="jr-payment-other"><h4>Другие способы</h4><div class="jr-pay-shortcuts">${jrStub('Сертификаты и абонементы', 'wallet', 'jr-stub-inline')}${jrStub('QR-код / СБП', 'wallet', 'jr-stub-inline')}${jrStub('Оплата по ссылке', 'wallet', 'jr-stub-inline')}</div></div><div class="jr-actions"><button type="button" class="btn btn-pri" id="jrPayDone">Готово</button>${p.recordId != null ? '<button type="button" class="btn btn-sec" id="jrPayBack">К записи</button>' : ''}<button type="button" class="btn btn-sec" id="jrPayClose">Закрыть</button></div></section></div>`;
  jrEl('jrModal').scrollTop = keepScroll ? scroll : 0;
  jrEl('jrPayDone').onclick = jrPayDone;
  jrEl('jrPayClose').onclick = () => jrClose();
  if (p.recordId != null) jrEl('jrPayBack').onclick = () => jrPayBack(p.recordId);
  jrEl('jrPayPartial').oninput = () => { const selected = journal.payment?.arrival; jrClearArrivalConfirmation(); if (selected) jrMessage('Сумма изменилась. Выберите способ оплаты заново.'); };
  const body = jrEl('jrModalBody');
  body.querySelectorAll('[data-method-index]').forEach(b => b.onclick = () => jrPayMethod(Number(b.dataset.methodIndex)));
  body.querySelectorAll('[data-remove-payment]').forEach(b => b.onclick = () => jrRemovePayment(Number(b.dataset.removePayment)));
  body.querySelectorAll('[data-restore-payment]').forEach(b => b.onclick = () => jrRestorePayment(Number(b.dataset.restorePayment)));
  body.querySelectorAll('[data-drop-payment]').forEach(b => b.onclick = () => jrDropPayment(Number(b.dataset.dropPayment)));
}
function jrClearArrivalConfirmation() {
  if (journal.payment) delete journal.payment.arrival;
  const host = jrEl('jrPayArrival');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}
function jrAddPayment(payment) {
  if (!journal.session || !journal.payment) return;
  (journal.session.payments ||= []).push(payment);
  jrMessage('');
  jrRenderPayment();
}
function jrConfirmArrivalPayment(selection) {
  if (journal.busy) return;
  const p = journal.payment, method = p?.data?.methods?.[selection?.index];
  if (!selection || p?.arrival !== selection || selection.modalRequest !== journal.modalRequest) return;
  if (method?.method !== 'account' || method.requiresArrivalConfirmation !== true || !method.available) { jrClearArrivalConfirmation(); return; }
  const entered = jrEl('jrPayPartial').value, amount = entered === '' ? method.limit : Number(entered);
  if (!Number.isFinite(amount) || amount <= 0 || amount > method.limit || amount !== selection.payment.amount) {
    jrClearArrivalConfirmation(); jrMessage('Сумма изменилась. Выберите способ оплаты заново.'); return;
  }
  jrClearArrivalConfirmation();
  jrAddPayment({ ...selection.payment, confirmArrival: true });
}
function jrPayMethod(index) {
  if (journal.busy) return;
  const p = journal.payment, method = p?.data?.methods?.[index];
  if (p?.readOnly || !method?.available || !method.limit) return;
  jrClearArrivalConfirmation();
  const entered = jrEl('jrPayPartial').value, amount = entered === '' ? method.limit : Number(entered);
  if (!Number.isFinite(amount) || amount <= 0 || amount > method.limit) { jrMessage('Укажите сумму больше нуля и не больше доступной для этого способа.'); return; }
  const payment = { method: method.method, methodId: method.id, amount };
  if (method.method === 'account' && method.requiresArrivalConfirmation === true) {
    const selection = { index, payment, modalRequest: journal.modalRequest }; p.arrival = selection;
    const host = jrEl('jrPayArrival');
    host.innerHTML = `<div class="jr-pay-review"><p>Оплата изменит статус визита на <strong>«Пришёл»</strong>. Подтверждайте только фактический приход клиента.</p><p><strong>${jrEscape(method.title)} · ${jrRub(amount)}</strong></p><div class="jr-actions"><button type="button" class="btn btn-pri" id="jrPayArrivalConfirm">Оплатить и отметить приход</button><button type="button" class="btn btn-sec" id="jrPayArrivalCancel">Отмена</button></div></div>`;
    host.hidden = false;
    jrEl('jrPayArrivalConfirm').onclick = () => jrConfirmArrivalPayment(selection);
    jrEl('jrPayArrivalCancel').onclick = () => { jrClearArrivalConfirmation(); jrMessage(''); };
    jrMessage('Подтвердите приход клиента и выбранную оплату.');
    return;
  }
  jrAddPayment(payment);
}
function jrRemovePayment(index) {
  if (journal.busy || !journal.session || journal.payment?.readOnly) return;
  const t = journal.payment?.base?.paid?.[index];
  if (!t) return;
  const list = (journal.session.removePayments ||= []);
  if (!list.some(x => x.method === t.method && x.transactionId === t.id)) list.push({ transactionId: t.id, method: t.method, methodId: t.methodId, amount: t.amount });
  jrRenderPayment();
}
function jrRestorePayment(index) {
  if (journal.busy || !journal.session) return;
  const t = journal.payment?.base?.paid?.[index];
  if (!t) return;
  journal.session.removePayments = (journal.session.removePayments || []).filter(x => !(x.method === t.method && x.transactionId === t.id));
  jrRenderPayment();
}
function jrDropPayment(index) {
  if (journal.busy || !journal.session?.payments?.[index]) return;
  journal.session.payments.splice(index, 1);
  jrRenderPayment();
}
function jrPayDone() {
  if (journal.busy) return;
  if (jrSessionPending()) return jrSave(jrSessionBody());
  jrClose(true);
}
function jrPayBack(recordId) {
  if (journal.busy) return;
  if (jrSessionPending()) {
    if (typeof confirm === 'function' && confirm('Сохранить изменения?')) return jrSave(jrSessionBody());
  }
  return jrOpen(recordId);
}
// Local data renders at once; live YClients data replaces it silently while
// nothing has been chosen yet. A live failure keeps the local form.
// What to show once the live sale arrives. Live knows only the YClients sale, not
// our outbox queue: with queued/sending/failed payments the local form stays.
function jrMergeLivePayment(local, live) {
  if (!live) return local || null;
  if (!local) return live;
  if ((Array.isArray(local.payments) ? local.payments : []).some(p => p && p.status !== 'confirmed')) return local;
  const paid = Array.isArray(live.paid) ? live.paid : [];
  const liveItems = Array.isArray(live.items) ? live.items : [];
  const localItems = Array.isArray(local.items) ? local.items : [];
  const same = localItems.length === liveItems.length && localItems.every((i, n) => i.title === liveItems[n].title);
  const items = same ? localItems : liveItems;
  const sum = (list, f = () => true) => list.filter(f).reduce((n, x) => n + jrKop(x.amount), 0);
  const money = k => k / 100;
  const detailed = items.length > 0 && items.every(i => i.gross !== undefined && i.gross !== null);
  const total = items.reduce((n, i) => n + jrKop(i.total), 0);
  const gross = detailed ? items.reduce((n, i) => n + jrKop(i.gross), 0) : total;
  const summary = { gross: money(Math.max(gross, total)), discount: money(detailed ? items.reduce((n, i) => n + jrKop(i.discount), 0) : 0), total: money(total),
    paidConfirmed: money(sum(paid)), paidQueued: 0, bonusSpent: money(sum(paid, t => t.method === 'loyalty_card')), due: live.due };
  const payments = paid.map(t => ({ method: t.method, methodId: t.methodId, title: t.title, amount: t.amount, status: 'confirmed', kind: 'payment', outboxId: null }));
  return { ...live, items, payments, summary };
}
async function jrOpenPayment(recordId, preferred = 'all') {
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.payment = null;
  const session = journal.session = jrNewSession({ recordId, payments: [], removePayments: [] });
  jrShowModal('Оплата визита', true);
  jrEl('jrModal').className = 'jr-dialog jr-dialog-wide jr-dialog-payment';
  const current = () => request === journal.modalRequest && journal.session === session;
  const localP = jrApi(`payments/${recordId}?local=1`);
  const liveP = Number(recordId) > 0 ? jrApi('payments/' + recordId).catch(() => null) : null;
  let shown = false, local = null;
  try {
    const data = await localP;
    if (!current()) return false;
    local = data;
    jrPaymentShow(data, { preferred, keepScroll: false }); shown = true;
  } catch (e) {
    if (current() && !liveP) {
      jrMessage(e.message);
      jrEl('jrModalBody').innerHTML = '<button type="button" class="btn btn-sec" id="jrPayReload">Повторить загрузку оплаты</button>';
      jrEl('jrPayReload').onclick = () => jrOpenPayment(recordId, preferred);
      return false;
    }
  }
  if (liveP) {
    const live = await liveP;
    if (!current()) return shown;
    const untouched = !session.payments.length && !session.removePayments.length && !journal.payment?.arrival;
    const view = jrMergeLivePayment(local, live);
    if (live && view === local && shown) { /* queue is only known locally: keep the local form */ }
    else if (live && (untouched || !shown)) { jrPaymentShow(view, { preferred, live: true }); jrMessage(''); shown = true; }
    else if (!shown) {
      jrMessage('Не удалось загрузить оплату визита.');
      jrEl('jrModalBody').innerHTML = '<button type="button" class="btn btn-sec" id="jrPayReload">Повторить загрузку оплаты</button>';
      jrEl('jrPayReload').onclick = () => jrOpenPayment(recordId, preferred);
    }
  }
  return shown;
}

// «Оплата визита» from the card (11.11.2026): an unsaved status/services edit
// (typically «Пришёл») is saved as its own package first, then the payment form
// opens. Before, the button was disabled after any change and the cashier had
// to save, reopen the card and only then pay.
async function jrPayFromCard(recordId) {
  if (journal.busy) return;
  if (journal.session?.edit && !journal.payment) {
    const saved = await jrSave(jrSessionBody());
    if (!saved) return false;
  }
  return jrOpenPayment(recordId);
}
function jrBindRecordEdit(record) {
  journal.session = jrNewSession({ recordId: record.id, servicesVersion: record.servicesVersion });
  const changed = () => {
    jrEl('jrSaveChanges').disabled = false;
    // Other workflows open a new session; save this draft before entering them.
    // Cancel would contradict the draft; payment stays open — it saves the draft
    // first (the server keeps edits and payments in separate packages).
    if (jrEl('jrCancel')) jrEl('jrCancel').disabled = true;
  };
  jrEl('jrModalBody').querySelectorAll('[data-attendance]').forEach(button => {
    button.onclick = () => {
      journal.session.edit ||= {};
      journal.session.edit.attendance = Number(button.dataset.attendance);
      jrEl('jrModalBody').querySelectorAll('.jr-state-pill').forEach(el => {
        el.classList.remove('is-current'); el.removeAttribute('aria-current');
      });
      button.classList.add('is-current'); button.setAttribute('aria-current', 'true');
      jrSetCardStatus(journal.session.edit.attendance);
      changed();
    };
  });
  jrEl('jrSaveChanges').onclick = () => jrSave(jrSessionBody());
  jrEl('jrEditServices').onclick = () => {
    const panel = jrEl('jrModalBody').querySelector('.jr-service-panel');
    let lines = record.services.map(s => ({ serviceId: s.id, title: s.title, quantity: s.quantity || 1,
      unitPrice: s.unitPrice ?? s.cost, total: s.cost, mode: 'total', discount: 0 }));
    const choices = (journal.data?.services || []).filter(s => s.yclientsId > 0 && s.staffIds.includes(record.staffId));
    const mark = () => {
      journal.session.edit ||= {};
      journal.session.edit.lines = lines.map(({ title, ...line }) => line);
      changed();
    };
    const render = () => {
      panel.innerHTML = `<h3>Услуги и стоимость</h3>${lines.map((l, i) => {
        const calc = jrLineCalculation(l);
        return `<section class="jr-line-editor"><div class="jr-line-heading"><strong>${jrEscape(l.title)}</strong><button type="button" data-remove="${i}" aria-label="Удалить услугу">×</button></div><div class="jr-line-fields">${[['quantity','Кол-во'],['unitPrice','Цена, ₽'],['discount','Скидка, %'],['total','Итого, ₽']].map(([key,label]) => `<label>${label}<input type="number" min="${key === 'quantity' ? 1 : 0}" step="${key === 'quantity' ? 1 : '0.01'}" data-edit-line="${i}" data-field="${key}" value="${jrEscape(key === 'total' ? calc?.total ?? l.total : key === 'discount' && l.mode === 'total' ? calc?.discount ?? 0 : l[key])}"></label>`).join('')}</div></section>`;
      }).join('')}<label>Добавить услугу<select id="jrAddService"><option value="">Выберите услугу</option>${choices.filter(s => !lines.some(l => l.serviceId === s.yclientsId)).map(s => `<option value="${s.yclientsId}">${jrEscape(s.title)}</option>`).join('')}</select></label><p class="jr-hint">Длительность визита сохраняется. Изменения отправятся по кнопке «Сохранить изменения».</p>`;
      panel.querySelectorAll('[data-edit-line]').forEach(input => { input.onchange = () => {
        const l = lines[Number(input.dataset.editLine)], key = input.dataset.field;
        const discount = jrLineCalculation(l)?.discount ?? 0;
        l[key] = input.value;
        l.mode = key === 'total' ? 'total' : 'discount';
        if (key !== 'discount') l.discount = discount;
        mark(); render();
      }; });
      panel.querySelectorAll('[data-remove]').forEach(b => { b.onclick = () => { lines.splice(Number(b.dataset.remove), 1); mark(); render(); }; });
      jrEl('jrAddService').onchange = e => {
        const s = choices.find(s => s.yclientsId === Number(e.target.value));
        if (!s) return;
        const price = s.staffDetails?.find(x => x.id === record.staffId)?.priceMin ?? s.priceMin ?? 0;
        lines.push({serviceId:s.yclientsId,title:s.title,quantity:1,unitPrice:price,total:price,discount:0,mode:'discount'});
        mark(); render();
      };
    };
    render(); jrEl('jrEditServices').disabled = true;
  };
  jrEl('jrModalBody').querySelectorAll('[data-service-line]').forEach(line => { line.onclick = () => jrEl('jrEditServices').onclick(); });
}
