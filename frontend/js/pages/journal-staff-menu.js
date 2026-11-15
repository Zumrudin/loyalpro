// Employee/day schedule menu. Saves a full-day change locally; only explicit
// «Отправить в YClients» releases it to the integration worker.
function jrStaffMenuButton(staff, date, label) {
  const id = Number(staff.id), working = staff.working === true;
  const menuId = `jrStaffMenu-${id}-${date}`;
  const actions = working
    ? '<button type="button" role="menuitem" data-staff-action="break">Добавить перерыв</button><button type="button" role="menuitem" data-staff-action="remove">Убрать рабочий день</button>'
    : '<button type="button" role="menuitem" data-staff-action="add">Добавить рабочий день</button>';
  const sync = staff.scheduleSync;
  const status = sync ? `<button type="button" class="jr-schedule-status${sync.status === 'failed' ? ' is-error' : ''}" onclick="jrScheduleChangesOpen()">${sync.status === 'failed' ? 'График не отправлен: ошибка' : sync.status === 'done' ? 'График отправлен' : sync.released ? 'График отправляется…' : 'График ждёт отправки'}</button>` : '';
  return `${status}<div class="jr-staff-menu" data-staff-menu><button type="button" class="jr-staff-menu-toggle" data-staff-menu-toggle data-staff="${id}" data-date="${jrEscape(date)}" data-name="${jrEscape(staff.name || '')}" data-working="${working ? 1 : 0}" aria-haspopup="menu" aria-expanded="false" aria-controls="${jrEscape(menuId)}" aria-label="${jrEscape(`График: ${staff.name || ''}, ${date}`)}"><span>${jrEscape(label)}</span><span aria-hidden="true">▾</span></button><div class="jr-staff-menu-list" id="${jrEscape(menuId)}" role="menu" hidden>${actions}</div></div>`;
}
function jrStaffMenuClose(focus = false) {
  const root = journal.staffMenu;
  if (!root) return;
  const toggle = root.querySelector('[data-staff-menu-toggle]');
  const menu = root.querySelector('[role="menu"]');
  if (menu) menu.hidden = true;
  toggle?.setAttribute('aria-expanded', 'false');
  root.classList?.remove('is-open');
  root.closest?.('.jr-heading')?.classList?.remove('is-menu-open');
  journal.staffMenu = null;
  if (focus) toggle?.focus?.();
}
function jrStaffMenuToggle(root) {
  if (!root) return;
  const menu = root.querySelector('[role="menu"]');
  const toggle = root.querySelector('[data-staff-menu-toggle]');
  if (!menu || !toggle) return;
  if (journal.staffMenu === root && !menu.hidden) { jrStaffMenuClose(); return; }
  jrStaffMenuClose();
  journal.staffMenu = root;
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  root.classList?.add('is-open');
  root.closest?.('.jr-heading')?.classList?.add('is-menu-open');
  root.querySelector('[data-staff-action]')?.focus?.();
}
function jrBindStaffMenus(grid) {
  jrStaffMenuClose();
  grid.querySelectorAll('[data-staff-menu]').forEach(root => {
    const toggle = root.querySelector('[data-staff-menu-toggle]');
    toggle?.addEventListener('click', event => { event.stopPropagation(); jrStaffMenuToggle(root); });
    root.querySelectorAll('[data-staff-action]').forEach(button => button.addEventListener('click', () => {
      const context = Object.freeze({
        staffId: Number(toggle.dataset.staff), date: toggle.dataset.date,
        name: toggle.dataset.name, working: toggle.dataset.working === '1',
      });
      const action = button.dataset.staffAction;
      jrStaffMenuClose();
      jrStaffMenuForm(context, action);
    }));
  });
}
const JR_SCHEDULE_ADD_PRESETS = [
  ['10:00', '22:00'], ['11:00', '20:00'], ['10:00', '22:05'],
  ['11:00', '20:05'], ['11:00', '20:30'], ['11:00', '20:15'],
];
function jrScheduleBreakValues() {
  return Array.from(jrEl('jrScheduleBreakList')?.querySelectorAll('.jr-schedule-break-row') || []).map(row => ({
    start: row.querySelector('[data-schedule-break-start]')?.value || '',
    end: row.querySelector('[data-schedule-break-end]')?.value || '',
  }));
}
function jrScheduleBreakRender(breaks = []) {
  const host = jrEl('jrScheduleBreakList');
  if (!host) return;
  host.innerHTML = breaks.map((item, index) => `<div class="jr-schedule-break-row" data-schedule-break="${index}">
    <label>Начало<input type="time" required step="300" data-schedule-break-start value="${jrEscape(item.start || '')}"></label>
    <span aria-hidden="true">—</span>
    <label>Окончание<input type="time" required step="300" data-schedule-break-end value="${jrEscape(item.end || '')}"></label>
    <button type="button" class="jr-icon-btn" data-schedule-break-remove="${index}" aria-label="Убрать перерыв">×</button>
  </div>`).join('');
  host.querySelectorAll('[data-schedule-break-remove]').forEach(button => {
    button.onclick = () => {
      const values = jrScheduleBreakValues();
      values.splice(Number(button.dataset.scheduleBreakRemove), 1);
      jrScheduleBreakRender(values);
    };
  });
}
function jrSchedulePresetSelection() {
  const start = jrEl('jrScheduleStart')?.value, end = jrEl('jrScheduleEnd')?.value;
  jrEl('jrScheduleForm')?.querySelectorAll('[data-schedule-preset]').forEach(button => {
    const selected = button.dataset.start === start && button.dataset.end === end;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}
function jrScheduleBindAddControls() {
  jrEl('jrScheduleForm')?.querySelectorAll('[data-schedule-preset]').forEach(button => {
    button.onclick = () => {
      jrEl('jrScheduleStart').value = button.dataset.start;
      jrEl('jrScheduleEnd').value = button.dataset.end;
      jrSchedulePresetSelection();
    };
  });
  for (const id of ['jrScheduleStart', 'jrScheduleEnd']) jrEl(id).oninput = jrSchedulePresetSelection;
  jrEl('jrScheduleBreakAdd').onclick = () => jrScheduleBreakRender([...jrScheduleBreakValues(), { start: '', end: '' }]);
  jrScheduleBreakRender([]);
  jrSchedulePresetSelection();
}
function jrScheduleAddFields() {
  return `<div class="jr-schedule-times"><label>Начало<input type="time" id="jrScheduleStart" required step="300" value="10:00"></label><label>Окончание<input type="time" id="jrScheduleEnd" required step="300" value="22:00"></label></div>
    <div class="jr-schedule-presets" role="group" aria-label="Готовые варианты рабочего времени">${JR_SCHEDULE_ADD_PRESETS.map(([start, end]) => `<button type="button" class="jr-schedule-preset" data-schedule-preset data-start="${start}" data-end="${end}" aria-pressed="false">${start} – ${end}</button>`).join('')}</div>
    <section class="jr-schedule-breaks"><div class="jr-schedule-break-head"><span>Перерывы</span><button type="button" class="jr-schedule-break-add" id="jrScheduleBreakAdd">＋ Добавить перерыв</button></div><div class="jr-schedule-break-list" id="jrScheduleBreakList"></div></section>`;
}
function jrScheduleOpenForm(context, action, options = {}) {
  const title = options.title || { break: 'Добавить перерыв', add: 'Добавить рабочий день', remove: 'Убрать рабочий день' }[action];
  journal.modalRequest++; journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null;
  jrShowModal(title);
  if (action === 'add') jrEl('jrModal').classList?.add('jr-dialog-schedule-add');
  journal.scheduleForm = { context, action, sessionId: crypto.randomUUID(), staffOptions: options.staffOptions || null };
  const staffField = options.staffOptions
    ? `<label>Сотрудник<select id="jrScheduleStaff" required><option value="" selected disabled>Выберите сотрудника</option>${options.staffOptions.map(s => `<option value="${Number(s.id)}">${jrEscape(s.name || 'Сотрудник')}</option>`).join('')}</select></label>`
    : `<label>Сотрудник<input id="jrScheduleStaff" value="${jrEscape(context.name)}" readonly></label>`;
  const times = action === 'remove' ? '' : action === 'add' ? jrScheduleAddFields()
    : '<div class="jr-schedule-times"><label>Начало<input type="time" id="jrScheduleStart" required step="300"></label><label>Окончание<input type="time" id="jrScheduleEnd" required step="300"></label></div>';
  jrEl('jrModalBody').innerHTML = `<form id="jrScheduleForm" class="jr-schedule-form${action === 'add' ? ' jr-schedule-add-form' : ''}">
    <p class="jr-hint">Изменение сохранится только в журнале. В YClients оно уйдёт через «Отправить в YClients».</p>
    ${staffField}
    <label>Дата<input type="date" id="jrScheduleDate" value="${jrEscape(context.date)}" readonly></label>
    ${times}
    ${action === 'remove' ? '<p class="jr-schedule-warning">Рабочие интервалы на весь день будут убраны. Записи не отменяются; при пересечении изменение будет отклонено.</p>' : ''}
    <div class="jr-actions"><button type="button" class="btn btn-sec" onclick="jrClose(true)">Отмена</button><button type="submit" class="btn btn-pri" id="jrScheduleSave">${action === 'remove' ? 'Убрать день' : action === 'add' ? 'Добавить' : 'Сохранить в журнале'}</button></div>
  </form>`;
  jrEl('jrScheduleForm').onsubmit = event => { event.preventDefault(); jrStaffScheduleSave(); };
  if (action === 'add') jrScheduleBindAddControls();
}
function jrStaffMenuForm(context, action) {
  if (!context || !['break', 'add', 'remove'].includes(action)) return;
  jrScheduleOpenForm(context, action);
}
function jrScheduleAddOpen() {
  const data = journal.data;
  const date = String(jrEl('jrDate')?.value || '');
  if (!data || !date || data.date !== date) {
    notify('Дождитесь загрузки журнала для выбранной даты.', 'err');
    return false;
  }
  // The modal owns a stable snapshot: a silent journal refresh must not change
  // the selectable employee names or ids in an already opened form.
  const staff = Object.freeze((data.staff || []).filter(s => s.working !== true)
    .map(s => Object.freeze({ id: Number(s.id), name: String(s.name || 'Сотрудник') })));
  if (!staff.length) {
    notify('На выбранную дату все сотрудники уже работают.', 'err');
    return false;
  }
  const first = staff[0];
  const context = Object.freeze({ staffId: Number(first.id), name: String(first.name || 'Сотрудник'), date, working: false });
  jrScheduleOpenForm(context, 'add', { title: 'Добавление сотрудника в расписание', staffOptions: staff });
  return true;
}
async function jrStaffScheduleSave() {
  const state = journal.scheduleForm;
  if (!state || journal.busy) return false;
  const { action } = state;
  let context = state.context;
  if (state.staffOptions) {
    const staffId = Number(jrEl('jrScheduleStaff').value);
    const selected = state.staffOptions.find(s => Number(s.id) === staffId);
    if (!selected) { jrMessage('Выберите сотрудника.'); return false; }
    context = Object.freeze({ staffId, name: String(selected.name || 'Сотрудник'), date: state.context.date, working: false });
    state.context = context;
  }
  if (action === 'remove' && !confirm(`Убрать рабочий день ${context.date} у сотрудника ${context.name}? Записи не будут отменены.`)) return false;
  const body = {
    sessionId: state.sessionId, action, staffId: context.staffId, date: context.date,
    ...(action === 'remove' ? {} : { start: jrEl('jrScheduleStart').value, end: jrEl('jrScheduleEnd').value }),
    ...(action === 'add' ? { breaks: jrScheduleBreakValues() } : {}),
  };
  let saved = false;
  await jrWithBusy('Сохраняем…', async () => {
    try { await jrApi('staff-schedule', body); saved = true; }
    catch (error) {
      if (error.code === 'session_used') {
        jrMessage('Предыдущая версия формы уже сохранена. Новое время не сохранено. Проверьте «Изменения графика» перед повтором.');
        state.sessionId = crypto.randomUUID();
        return;
      }
      jrMessage(error.message);
      if (error.status >= 400 && error.status < 500 && journal.scheduleForm === state) state.sessionId = crypto.randomUUID();
    }
  });
  if (!saved) return false;
  journal.scheduleForm = null;
  jrMessage(''); jrClose(true);
  notify('График сохранён в журнале.');
  loadJournal({ silent: true });
  return saved;
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', event => {
    if (journal.staffMenu && !journal.staffMenu.contains(event.target)) jrStaffMenuClose();
  });
  document.addEventListener('keydown', event => {
    const root = journal.staffMenu;
    if (!root) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); jrStaffMenuClose(true); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(root.querySelectorAll('[data-staff-action]')).filter(item => !item.disabled);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length : (current - 1 + items.length) % items.length;
    items[next].focus();
  });
}

// Always reachable from the toolbar, even when a failed day removal hides a
// staff column or the user has navigated to another date.
async function jrScheduleChangesOpen() {
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null; journal.scheduleForm = null;
  jrShowModal('Изменения графика');
  try {
    const rows = await jrApi('staff-schedule/changes');
    if (request !== journal.modalRequest) return;
    const names = new Map((journal.data?.staff || []).map(s => [Number(s.id), s.name]));
    jrEl('jrModalBody').innerHTML = rows.length ? rows.map(row => {
      const title = names.get(row.staffId) || `Сотрудник №${row.staffId}`;
      const status = row.status === 'failed' ? 'Ошибка отправки' : row.status === 'running' || row.released ? 'Отправляется' : 'Ждёт отправки';
      return `<div class="jr-review-row"><strong>${jrEscape(title)} · ${jrEscape(row.date)}</strong><p>${status}${row.errorText ? ': ' + jrEscape(row.errorText) : ''}</p>${row.status === 'failed' ? `<button type="button" class="btn btn-sec" data-schedule-retry="${row.outboxId}" ${row.errorCode === 'uncertain' ? 'disabled' : ''}>Повторить отправку</button> <button type="button" class="btn btn-sec" data-schedule-dismiss="${row.outboxId}">Убрать локальное изменение</button>` : ''}</div>`;
    }).join('') + '<p class="jr-hint">При неподтверждённом результате владелец сначала выполняет сверку в YClients. Новые изменения отправляются общей кнопкой «Отправить в YClients».</p>' : '<p>Незавершённых изменений графика нет.</p>';
    for (const action of ['retry', 'dismiss']) jrEl('jrModalBody').querySelectorAll(`[data-schedule-${action}]`).forEach(button => {
      button.onclick = async () => {
        if (journal.busy) return;
        if (action === 'dismiss' && !confirm('Убрать локальное изменение и загрузить актуальный график из YClients?')) return;
        let done = false;
        await jrWithBusy('Обрабатываем…', async () => {
          try {
            await jrApi(`staff-schedule/${Number(button.dataset[action === 'retry' ? 'scheduleRetry' : 'scheduleDismiss'])}/${action}`, {});
            done = true;
          } catch (e) { jrMessage(e.message); }
        });
        if (done && request === journal.modalRequest) { loadJournal({ silent: true }); jrScheduleChangesOpen(); }
      };
    });
  } catch (e) { if (request === journal.modalRequest) jrMessage(e.message); }
}
