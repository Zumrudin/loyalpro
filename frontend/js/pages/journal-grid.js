// Журнал записи: сетка дня и недели. Общая глобальная область с journal.js (префикс jr).
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
