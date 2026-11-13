// Журнал записи: сетка дня и недели. Общая глобальная область с journal.js (префикс jr).
// Minutes a visit occupies on the grid: its length plus the technical break.
const jrOccupied = r => (r.duration > 0 ? r.duration : 15) + (Number(r.technicalBreak) > 0 ? Number(r.technicalBreak) / 60 : 0);
function jrCellState(staff, minute, date, records, now = Date.now()) {
  const ranges = staff.workRanges || [];
  if (!ranges.some(r => minute >= r.start && minute + 15 <= r.end)) {
    // Between two intervals of one shift = the master's break, not «off» (spec §3.2).
    return ranges.some(r => r.end <= minute) && ranges.some(r => r.start >= minute + 15) ? 'break' : 'off';
  }
  if (Date.parse(date + 'T00:00:00+03:00') + minute * 60000 <= now) return 'past';
  // Use ALL appointments, including those hidden by a search filter.
  if (records.some(r => r.staffId === staff.id && !r.deleted && r.time &&
    minute < jrMinutes(r.time) + jrOccupied(r) && minute + 15 > jrMinutes(r.time))) return 'busy';
  return 'free';
}
function jrGridCreate(staffId, time, date) {
  if (!journal.data) return;
  const day = journal.view === 'week' && journal.week ? journal.week.days.find(d => d.date === date) : null;
  const staff = day ? { id: journal.week.staff.id, workRanges: day.workRanges || [] } : jrStaffList().find(s => s.id === staffId);
  const when = day ? day.date : journal.data.date;
  if (!staff || jrCellState(staff, jrMinutes(time), when, day ? day.records : journal.data.records) !== 'free') return;
  jrForm(null, { staffId, time, date: when });
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
      r.lane = lane; lanes[lane] = r.start + Math.max(jrOccupied(r), 5);
    }
    group.forEach(r => { r.lanes = lanes.length; });
  };
  for (const r of sorted) {
    if (r.start >= end) { finish(); group = []; end = -1; }
    group.push(r); end = Math.max(end, r.start + Math.max(jrOccupied(r), 5));
  }
  finish(); return sorted;
}
// Record colour (spec §3.2): custom_color wins over the status colour; text is
// custom_font_color or an automatic contrast. Only #rrggbb ever reaches style=.
const JR_HEX = /^#[0-9a-f]{6}$/i;
function jrContrastColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#333';
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#333' : '#fff';
}
function jrVisitStyle(r) {
  if (!JR_HEX.test(r.customColor || '')) return '';
  const font = JR_HEX.test(r.fontColor || '') ? r.fontColor : jrContrastColor(r.customColor);
  return `--jr-yc:${r.customColor};--jr-yc-bd:${r.customColor};color:${font};`;
}
// A label from our own overlay is a bare id: title/colour come from the salon list.
function jrLabelOf(l) {
  const known = (journal.data?.labels || []).find(x => Number(x.id) === Number(l.id)) || {};
  const color = JR_HEX.test(l.color || '') ? l.color : JR_HEX.test(known.color || '') ? known.color : '#999999';
  return { id: l.id, title: l.title || known.title || 'Метка', color };
}
function jrVisitMarks(r) {
  const dots = (r.labels || []).map(jrLabelOf).map(l => `<i class="jr-label-dot" style="background:${l.color}" title="${jrEscape(l.title)}"></i>`).join('');
  const icons = [r.online && ['🌐', 'Онлайн-запись'], r.isNew && ['✦', 'Новый клиент'], r.paidFull && ['💳', 'Оплачено'],
    String(r.comment || '').trim() && ['💬', 'Есть комментарий']].filter(Boolean)
    .map(([icon, title]) => `<span class="jr-mark" title="${title}" aria-label="${title}">${icon}</span>`).join('');
  return dots || icons ? `<span class="jr-marks">${dots}${icons}</span>` : '';
}
// Grid bounds in minutes: at least 08:00–21:00, widened by shifts and visits.
function jrBounds(records, ranges) {
  const timed = records.filter(r => r.time);
  const start = Math.max(0, Math.min(8 * 60, ...timed.map(r => Math.floor(jrMinutes(r.time) / 60) * 60), ...ranges.map(r => Math.floor(r.start / 60) * 60)));
  const end = Math.min(1440, Math.max(21 * 60, ...timed.map(r => Math.ceil((jrMinutes(r.time) + jrOccupied(r)) / 60) * 60), ...ranges.map(r => Math.ceil(r.end / 60) * 60)));
  return { start, end };
}
// One column (a master in the day view, a date in the week view).
function jrColumnHtml(s, date, records, allRecords, start, end, now) {
  let cells = '', prev = null;
  for (let t = start; t < end; t += 15) {
    const state = jrCellState(s, t, date, allRecords, now), time = jrTimeLabel(t);
    const position = `top:${(t - start) * JR_PX_PER_MIN}px;height:${15 * JR_PX_PER_MIN}px`;
    const classes = `jr-cell jr-cell-${state}${t % 60 === 0 ? ' jr-cell-hour' : ''}`;
    cells += state === 'free'
      ? `<button type="button" class="${classes}" data-staff="${s.id}" data-date="${date}" data-time="${time}" style="${position}" aria-label="${jrEscape(time + ' — новая запись, ' + (s.name || ''))}"><span>${time} Новый сеанс</span></button>`
      : `<div class="${classes}" style="${position}" aria-hidden="true">${state === 'break' && prev !== 'break' ? '<span>Перерыв</span>' : ''}</div>`;
    prev = state;
  }
  const visits = jrLayout(records).map(r => {
    const length = Math.min(Math.max(r.duration || 15, 5), end - r.start);
    const syncing = jrSyncing(r), failed = r.sync?.status === 'failed', unsent = jrUnsent(r);
    const title = r.time + ' · ' + r.clientName + ' · ' + r.services.map(x => x.title).join(', ') + (failed ? ' · Не передано в YClients: ' + (r.sync.errorText || 'причина неизвестна') : syncing ? ' · передаётся в YClients' : unsent ? ' · не отправлено в YClients' : '');
    const pos = `left:calc(${r.lane * 100 / r.lanes}% + 3px);width:calc(${100 / r.lanes}% - 6px)`;
    const pause = Number(r.technicalBreak) > 0 && !r.continued ? Math.min(Number(r.technicalBreak) / 60, end - r.start - length) : 0;
    const band = pause > 0 ? `<div class="jr-break-band" style="top:${(r.start + length - start) * JR_PX_PER_MIN}px;height:${Math.max(4, pause * JR_PX_PER_MIN - 2)}px;${pos}" title="Технический перерыв ${Math.round(pause)} мин" aria-hidden="true">⏸</div>` : '';
    return `<button type="button" class="jr-visit jr-status-${r.attendance}${r.paidFull ? ' jr-paid-full' : ''}${length < 30 ? ' jr-visit-short' : ''}${syncing ? ' jr-visit-syncing' : ''}${unsent ? ' jr-visit-unsent' : ''}${failed ? ' jr-visit-failed' : ''}" data-record="${r.id}" style="${jrVisitStyle(r)}top:${(r.start - start) * JR_PX_PER_MIN}px;height:${Math.max(6, length * JR_PX_PER_MIN - 2)}px;${pos}" title="${jrEscape(title)}" aria-label="${jrEscape(r.time + ' ' + r.clientName + ', ' + jrStatus(r) + (failed ? ', не передано в YClients' : syncing ? ', передаётся в YClients' : unsent ? ', не отправлено в YClients' : ''))}"><b>${syncing ? '⏳ ' : ''}${jrEscape(r.time)} · ${jrEscape(r.clientName)}${jrVisitMarks(r)}</b><span>${jrEscape(r.services.map(x => x.title).join(', ') || 'Без услуг')}</span><small>${r.continued ? 'Продолжение · ' : ''}${jrEscape(jrStatus(r))}${r.paid ? ' · оплачено' : ''}</small>${failed ? '<small class="jr-sync-failed-note">Не передано в YClients</small>' : unsent ? '<small class="jr-sync-unsent-note">Не отправлено в YClients</small>' : ''}</button>${band}`;
  }).join('');
  return `<div class="jr-column" data-staff="${s.id}" data-date="${date}">${cells}${visits}</div>`;
}
function jrHourLabels(start, end) {
  let labels = '';
  for (let t = start; t < end; t += 15) labels += `<span class="${t % 60 ? 'jr-quarter' : 'jr-hour'}" style="top:${(t - start) * JR_PX_PER_MIN}px">${t % 60 ? String(t % 60).padStart(2, '0') : jrTimeLabel(t)}</span>`;
  return labels;
}
function jrBindGrid(grid) {
  grid.querySelectorAll('[data-record]').forEach(el => el.addEventListener('click', () => jrOpen(Number(el.dataset.record))));
  grid.querySelectorAll('[data-time]').forEach(el => el.addEventListener('click', () => jrGridCreate(Number(el.dataset.staff), el.dataset.time, el.dataset.date)));
}
function jrRender() {
  if (!journal.data) return;
  if (journal.view === 'week' && journal.week) return jrRenderWeek();
  const filter = jrEl('jrStaffFilter').value;
  let staff = jrStaffList().filter(s => !filter || String(s.id) === filter);
  // Phone: one master at a time, switched by chips (spec 3.1).
  const mobile = jrIsMobile();
  if (mobile && staff.length > 1) staff = staff.slice(0, 1);
  jrRenderChips(mobile && staff.length > 0, staff[0]?.id);
  const query = jrEl('jrSearch').value.trim().toLowerCase();
  const allRecords = journal.data.records;
  const records = allRecords.filter(r => staff.some(s => s.id === r.staffId) && (!query || [r.clientName, ...r.services.map(s => s.title)].join(' ').toLowerCase().includes(query)));
  const grid = jrEl('jrGrid');
  if (!staff.length) { grid.innerHTML = `<p class="jr-empty">${jrEl('jrWorkingOnly').checked ? 'На выбранную дату нет работающих специалистов. Снимите фильтр «Только работающие», чтобы увидеть остальных.' : 'Специалистов пока нет.'}</p>`; return; }
  const { start, end } = jrBounds(records, staff.flatMap(s => s.workRanges || []));
  const height = (end - start) * JR_PX_PER_MIN;
  const now = Date.now();
  grid.innerHTML = `<div class="jr-calendar" data-start="${start}" style="--jr-columns:${staff.length};--jr-height:${height}px"><div class="jr-corner">Время</div>${staff.map(s => `<div class="jr-heading">${jrEscape(s.name)}<small>${s.working ? (s.workRanges || []).map(r => jrTimeLabel(r.start) + '–' + jrTimeLabel(r.end)).join(', ') || 'Рабочий день' : 'Выходной'} · ${records.filter(r => r.staffId === s.id).length} записей</small></div>`).join('')}<div class="jr-hours">${jrHourLabels(start, end)}</div>${staff.map(s => jrColumnHtml(s, journal.data.date, records.filter(r => r.staffId === s.id), allRecords, start, end, now)).join('')}</div>`;
  jrBindGrid(grid);
  if (!records.length && query) grid.insertAdjacentHTML('afterbegin', '<p class="jr-empty">Записей по запросу не найдено. Занятые интервалы остаются недоступны.</p>');
}
const JR_WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
function jrRenderWeek() {
  const w = journal.week, grid = jrEl('jrGrid');
  jrRenderChips(false);
  if (!w?.staff) { grid.innerHTML = '<p class="jr-empty">Специалистов пока нет.</p>'; return; }
  const query = jrEl('jrSearch').value.trim().toLowerCase();
  const match = r => !query || [r.clientName, ...(r.services || []).map(s => s.title)].join(' ').toLowerCase().includes(query);
  const { start, end } = jrBounds(w.days.flatMap(d => d.records), w.days.flatMap(d => d.workRanges || []));
  const now = Date.now();
  const column = d => ({ id: w.staff.id, name: w.staff.name, workRanges: d.workRanges || [] });
  grid.innerHTML = `<div class="jr-calendar jr-week" data-start="${start}" style="--jr-columns:7;--jr-height:${(end - start) * JR_PX_PER_MIN}px"><div class="jr-corner">${jrEscape(w.staff.name)}</div>${w.days.map((d, i) => `<div class="jr-heading${d.date === journal.data?.date ? ' is-selected' : ''}">${JR_WEEKDAYS[i]} ${d.date.slice(8, 10)}.${d.date.slice(5, 7)}<small>${d.working ? (d.workRanges || []).map(r => jrTimeLabel(r.start) + '–' + jrTimeLabel(r.end)).join(', ') || 'Рабочий день' : 'Выходной'} · ${d.records.length} записей</small></div>`).join('')}<div class="jr-hours">${jrHourLabels(start, end)}</div>${w.days.map(d => jrColumnHtml(column(d), d.date, d.records.filter(match), d.records, start, end, now)).join('')}</div>`;
  jrBindGrid(grid);
}
function jrRenderChips(mobile, currentId) {
  const box = jrEl('jrStaffChips');
  if (!box) return;
  box.hidden = !mobile;
  if (!mobile) { box.innerHTML = ''; return; }
  box.innerHTML = jrStaffList().map(s => `<button type="button" class="jr-chip${s.id === currentId ? ' is-active' : ''}" data-chip="${s.id}" aria-pressed="${s.id === currentId}">${jrEscape(s.name)}</button>`).join('');
  box.querySelectorAll('[data-chip]').forEach(b => { b.onclick = () => { jrEl('jrStaffFilter').value = b.dataset.chip; jrRender(); }; });
}
// Month calendar with day load (spec 3.1): Monday first, density 0-3 from the server (null = no schedule data).
function jrMonthCells(month, days) {
  const first = new Date(month + '-01T12:00:00Z');
  const lead = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const byDate = new Map((days || []).map(d => [d.date, d]));
  const cells = Array.from({ length: lead }, () => null);
  for (let i = 1; i <= count; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`, d = byDate.get(date);
    cells.push({ date, day: i, records: Number(d?.records) || 0, density: d?.density == null ? null : Number(d.density) || 0 });
  }
  return cells;
}
function jrMonthAdd(month, n) { const d = new Date(month + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
async function jrMonthPicker(month) {
  const box = jrEl('jrMonth');
  if (month === undefined && journal.monthOpen) { journal.monthOpen = false; box.hidden = true; return; }   // the 📅 button toggles
  month = month || (jrEl('jrDate').value || jrToday()).slice(0, 7);
  const request = journal.monthRequest = (journal.monthRequest || 0) + 1;
  box.hidden = false; journal.monthOpen = true;
  box.innerHTML = '<p class="jr-hint">Загрузка…</p>';
  let data;
  try { data = await jrApi('month?' + new URLSearchParams({ month })); }
  catch (e) { if (request === journal.monthRequest) box.innerHTML = `<p class="jr-hint">${jrEscape(e.message)}</p><button type="button" class="btn btn-sec" data-month-close>Закрыть</button>`; return; }
  if (request !== journal.monthRequest) return;
  const title = new Date(month + '-01T12:00:00Z').toLocaleDateString('ru', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const selected = jrEl('jrDate').value;
  box.innerHTML = `<div class="jr-month-head"><button type="button" class="btn btn-sec" data-month-shift="-1" aria-label="Предыдущий месяц">←</button><strong>${jrEscape(title)}</strong><button type="button" class="btn btn-sec" data-month-shift="1" aria-label="Следующий месяц">→</button><button type="button" class="btn btn-sec" data-month-close aria-label="Закрыть календарь">✕</button></div><div class="jr-month-grid">${JR_WEEKDAYS.map(d => `<span class="jr-month-wd">${d}</span>`).join('')}${jrMonthCells(month, data.days).map(c => c ? `<button type="button" class="jr-month-day${c.date === selected ? ' is-current' : ''}" data-month-date="${c.date}" title="Записей: ${c.records}"><span>${c.day}</span>${c.density == null ? '<i class="jr-density jr-density-none" aria-hidden="true"></i>' : `<i class="jr-density jr-density-${c.density}" aria-hidden="true">${'•'.repeat(c.density)}</i>`}</button>` : '<span></span>').join('')}</div>`;
  box.querySelectorAll('[data-month-date]').forEach(b => { b.onclick = () => { jrEl('jrDate').value = b.dataset.monthDate; box.hidden = true; journal.monthOpen = false; loadJournal(); }; });
  box.querySelectorAll('[data-month-shift]').forEach(b => { b.onclick = () => jrMonthPicker(jrMonthAdd(month, Number(b.dataset.monthShift))); });
  box.querySelectorAll('[data-month-close]').forEach(b => { b.onclick = () => { box.hidden = true; journal.monthOpen = false; }; });
}
// Crossing the 700px threshold re-lays the grid (one master <-> all masters).
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  let jrResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(jrResizeTimer);
    jrResizeTimer = setTimeout(() => { if (document.body?.dataset?.page === 'journal') { if (jrIsMobile() && journal.view !== 'day') { journal.view = 'day'; jrSyncViewButtons(); } jrRender(); } }, 200);
  });
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', e => {
    const box = document.getElementById('jrMonth');
    if (e.key === 'Escape' && box && journal.monthOpen) { journal.monthOpen = false; box.hidden = true; }
  });
}
