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
  const staff = jrStaffList().find(s => s.id === staffId);
  if (!staff || !journal.data || jrCellState(staff, jrMinutes(time), journal.data.date, journal.data.records) !== 'free') return;
  jrForm(null, { staffId, time, date: journal.data.date });
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
  const filter = jrEl('jrStaffFilter').value;
  const staff = jrStaffList().filter(s => !filter || String(s.id) === filter);
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
