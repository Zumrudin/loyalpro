// Navigation calendar uses the journal's selected date; browsing months is local.
let sideCalendarMonth = '', sideCalendarSelected = '';
function sideCalendarCells(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const first = new Date(month + '-01T12:00:00Z');
  const offset = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(first); d.setUTCDate(first.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), day: d.getUTCDate() };
  });
}
function sideCalendarShift(amount) {
  const d = new Date(sideCalendarMonth + '-01T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + amount);
  sideCalendarMonth = d.toISOString().slice(0, 7);
  sideCalendarRender();
}
function sideCalendarSelect(date) {
  if (!_navAllowed('journal') || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const input = document.getElementById('jrDate');
  if (!input) return;
  input.value = date;
  sideCalendarSync(true);
  sideCalendarClose();
  if (typeof closeMenu === 'function') closeMenu();
  if (document.body.dataset.page === 'journal') loadJournal();
  else navTo('journal', { reset: true });
}
function sideCalendarClose() {
  document.querySelectorAll('.side-calendar').forEach(box => {
    box.classList.remove('calendar-open');
    box.querySelector('.side-calendar-trigger')?.setAttribute('aria-expanded', 'false');
  });
}
function sideCalendarRender() {
  const today = jrToday();
  const title = new Date(sideCalendarMonth + '-01T12:00:00Z').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/\s*г\.$/, '');
  document.querySelectorAll('.side-calendar-panel').forEach(panel => {
    panel.innerHTML = `<div class="side-calendar-head"><strong aria-live="polite">${title}</strong><button type="button" data-shift="-1" aria-label="Предыдущий месяц">‹</button><button type="button" data-shift="1" aria-label="Следующий месяц">›</button></div><div class="side-calendar-grid">${['пн','вт','ср','чт','пт','сб','вс'].map(day => `<span class="side-calendar-weekday">${day}</span>`).join('')}${sideCalendarCells(sideCalendarMonth).map(({date,day}) => `<button type="button" data-date="${date}" class="${date.slice(0,7) !== sideCalendarMonth ? 'outside ' : ''}${date === sideCalendarSelected ? 'selected ' : ''}${date === today ? 'today' : ''}" aria-label="${date}" aria-pressed="${date === sideCalendarSelected}"${date === today ? ' aria-current="date"' : ''}>${day}</button>`).join('')}</div>`;
    panel.querySelectorAll('[data-shift]').forEach(button => button.addEventListener('click', () => {
      const shift = button.dataset.shift;
      sideCalendarShift(Number(shift));
      panel.querySelector(`[data-shift="${shift}"]`)?.focus();
    }));
    panel.querySelectorAll('[data-date]').forEach(button => button.addEventListener('click', () => sideCalendarSelect(button.dataset.date)));
  });
}
function sideCalendarSync(force = false) {
  const selected = document.getElementById('jrDate')?.value || jrToday();
  if (!force && selected === sideCalendarSelected && sideCalendarMonth) return;
  sideCalendarSelected = selected;
  sideCalendarMonth = selected.slice(0,7);
  sideCalendarRender();
}
function sideCalendarInit() {
  ['mainNav', 'mnavList'].forEach((id, i) => {
    const nav = document.getElementById(id);
    if (!nav) return;
    let box = nav.querySelector('.side-calendar');
    if (!box) {
      box = document.createElement('section');
      box.className = 'side-calendar'; box.id = i ? 'mobileSidebarCalendar' : 'sidebarCalendar';
      box.setAttribute('aria-label', 'Календарь журнала');
      box.innerHTML = `<button type="button" class="side-calendar-trigger" aria-label="Открыть календарь" title="Календарь" aria-expanded="false" aria-controls="${box.id}Panel"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/></svg></button><div class="side-calendar-panel" id="${box.id}Panel"></div>`;
      nav.prepend(box);
      box.querySelector('.side-calendar-trigger').addEventListener('click', () => {
        const open = !box.classList.contains('calendar-open'); sideCalendarClose();
        box.classList.toggle('calendar-open', open);
        box.querySelector('.side-calendar-trigger').setAttribute('aria-expanded', String(open));
        if (open) {
          const panel = box.querySelector('.side-calendar-panel');
          const rect = box.getBoundingClientRect();
          panel.style.setProperty('--calendar-top', Math.max(8, Math.min(rect.top, window.innerHeight - 350)) + 'px');
          panel.querySelector('.selected')?.focus();
        }
      });
    }
    box.hidden = !_navAllowed('journal');
  });
  sideCalendarSelected = ''; sideCalendarSync();
}
document.addEventListener('click', event => { if (!event.target.closest('.side-calendar')) sideCalendarClose(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const open = document.querySelector('.side-calendar.calendar-open');
  if (open) { sideCalendarClose(); open.querySelector('.side-calendar-trigger')?.focus(); }
});
window.addEventListener('resize', sideCalendarClose);
