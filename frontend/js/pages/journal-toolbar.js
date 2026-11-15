// Journal toolbar: compact navigation, filters and popups.
const JR_TOOLBAR_STATUS_OPTIONS = [
  [0, 'Ожидание клиента'], [1, 'Клиент пришёл'], [-1, 'Клиент не пришёл'], [2, 'Клиент подтвердил'],
];
let jrSummaryRequest = 0;
const jrToolbarIcon = name => ({
  chevron: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
}[name] || '');
function jrToolbarSync() {
  const input = document.getElementById('jrDate'), label = document.getElementById('jrDateLabel');
  if (!input || !label || !input.value) return;
  const date = new Date(input.value + 'T12:00:00Z');
  const parts = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' }).formatToParts(date);
  const value = key => parts.find(part => part.type === key)?.value || '';
  label.textContent = `${value('day')} ${value('month')}, ${value('weekday')}`;
}
function jrToolbarStep(value) {
  const step = Number(value);
  if (![5, 10, 15].includes(step)) return;
  if (typeof jrSetGridStep === 'function') jrSetGridStep(step);
  document.querySelectorAll('[data-jr-step]').forEach(el => { el.checked = Number(el.value) === step; });
  jrToolbarPopupClose(true);
}
function jrToolbarStatuses() {
  if (!journal.statusFilter) journal.statusFilter = new Set([0, 1, -1, 2]);
  const selected = Array.from(document.querySelectorAll('[data-jr-status]:checked')).map(el => Number(el.value));
  journal.statusFilter = new Set(selected.length ? selected : []);
  if (typeof jrRender === 'function') jrRender();
  return journal.statusFilter;
}
function jrRecordVisible(record) {
  const filter = journal.statusFilter;
  return !(filter instanceof Set) || filter.has(Number(record && record.attendance));
}
function jrToolbarPopupClose(restoreFocus = false) {
  document.querySelectorAll('.jr-toolbar-popup:not([hidden])').forEach(popup => { popup.hidden = true; });
  document.querySelectorAll('.jr-toolbar [aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  const button = journal.toolbarPopupButton;
  journal.toolbarPopupButton = null;
  if (restoreFocus) button?.focus?.();
}
function jrToolbarPopupToggle(kind, button) {
  const popup = document.getElementById(`jr${kind[0].toUpperCase()}${kind.slice(1)}Popup`);
  if (!popup) return;
  const opening = popup.hidden;
  jrToolbarPopupClose(false);
  if (!opening) return;
  if (kind === 'scale') jrToolbarScaleRender(popup);
  if (kind === 'status') jrToolbarStatusRender(popup);
  if (kind === 'summary' && !popup.textContent.trim()) jrSummaryRender();
  popup.hidden = false;
  popup.style.left = kind === 'summary' ? 'auto' : `${Math.max(0, button.offsetLeft - 8)}px`;
  popup.style.right = kind === 'summary' ? '0' : 'auto';
  if (kind !== 'summary') {
    const box = popup.getBoundingClientRect();
    if (box.right > window.innerWidth) popup.style.left = `${Math.max(8, button.offsetLeft - box.width + button.offsetWidth)}px`;
    if (box.left < 0) popup.style.left = '8px';
  }
  journal.toolbarPopupButton = button;
  button?.setAttribute('aria-expanded', 'true');
  popup.querySelector('input,button')?.focus();
}
function jrToolbarScaleRender(popup) {
  const current = Number(journal.gridStep) || (typeof jrGridStep === 'function' ? Number(jrGridStep()) : 15) || 15;
  popup.innerHTML = `<strong>Масштаб</strong>${[5, 10, 15].map(value => `<label><input type="radio" name="jr-grid-step" data-jr-step value="${value}" ${value === current ? 'checked' : ''}>${value} минут</label>`).join('')}`;
  popup.querySelectorAll('[data-jr-step]').forEach(input => { input.onchange = () => jrToolbarStep(input.value); });
}
function jrToolbarStatusRender(popup) {
  if (!(journal.statusFilter instanceof Set)) journal.statusFilter = new Set([0, 1, -1, 2]);
  popup.innerHTML = `<strong>Статусы</strong>${JR_TOOLBAR_STATUS_OPTIONS.map(([value, label]) => `<label><input type="checkbox" data-jr-status value="${value}" ${journal.statusFilter.has(value) ? 'checked' : ''}>${label}</label>`).join('')}`;
  popup.querySelectorAll('[data-jr-status]').forEach(input => { input.onchange = jrToolbarStatuses; });
}
function jrSummaryRender(data) {
  const popup = document.getElementById('jrSummaryPopup'), total = document.getElementById('jrSummaryTotal');
  if (!popup) return;
  if (!data) { popup.innerHTML = '<p>Сводка будет доступна после подключения данных.</p>'; if (total) total.textContent = '—'; return; }
  if (data.loading) { popup.innerHTML = '<p>Загрузка сводки…</p>'; if (total) total.textContent = '—'; return; }
  if (data.error) { popup.innerHTML = `<p class="jr-summary-error">${jrToolbarEscape(data.error)}</p><button type="button" class="btn btn-sec jr-summary-retry" data-summary-retry>Повторить</button>`; popup.querySelector('[data-summary-retry]').onclick = () => jrSummaryLoad(data.date); if (total) total.textContent = '—'; return; }
  const rows = [
    ['Поступили в кассу', data.total, 'Подтверждённые деньги за день за вычетом возвратов. Товары включены; бонусы не входят.'],
    ['Оплата наличными', data.cash, 'Подтверждённые оплаты наличными за вычетом возвратов.'],
    ['Оплата безналичными', data.cashless, 'Подтверждённые безналичные оплаты за вычетом возвратов.'],
    ['Выполнено на сумму', data.completedAmount, 'Стоимость услуг в визитах со статусом «Клиент пришёл».'],
    ['Записей на сумму', data.bookedAmount, 'Стоимость услуг в активных записях со статусами ожидания, прихода или подтверждения.'],
    ['Лояльность на сумму', data.loyaltyAmount, 'Подтверждённые списания бонусов за вычетом возвратов.'],
    ['Товаров на сумму', data.goodsAmount, 'Подтверждённые продажи товаров; входят в общую сумму поступлений.'],
  ];
  if (data.otherAmount !== null && data.otherAmount !== undefined && Number.isFinite(Number(data.otherAmount)) && Number(data.otherAmount) !== 0) rows.push(['Прочие поступления', data.otherAmount, 'Денежные операции с прочим способом оплаты; входят в поступления.']);
  const clients = data.clientCount === null || data.clientCount === undefined || data.clientCount === '' ? null : (Number.isFinite(Number(data.clientCount)) ? Math.max(0, Number(data.clientCount)) : null);
  popup.innerHTML = `<strong>${jrToolbarDate(data.date || 'За день')}</strong>${clients == null ? '' : `<span class="jr-summary-clients">${clients} клиентов</span>`}${rows.map(([label, value, hint]) => `<div><span>${label} <i class="jr-summary-info" title="${jrToolbarEscape(hint)}" aria-label="${jrToolbarEscape(hint)}">i</i></span><b>${jrToolbarMoney(value)}</b></div>`).join('')}<div class="jr-summary-total"><span>Всего за день</span><b>${jrToolbarMoney(data.total)}</b></div>${Number(data.pendingCount) > 0 ? `<small class="jr-summary-pending">Ожидают подтверждения: ${Math.max(0, Number(data.pendingCount))}</small>` : ''}`;
  if (total) total.textContent = jrToolbarMoney(data.total).replace(/\s₽$/, '');
}
function jrToolbarMoney(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString('ru-RU')} ₽`;
}
function jrToolbarDate(value) {
  const match = /^\d{4}-\d\d-(\d\d)$/.exec(String(value || ''));
  if (!match) return jrToolbarEscape(value || 'За день');
  const date = new Date(`${value}T12:00:00Z`);
  return jrToolbarEscape(date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }));
}
function jrToolbarEscape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function jrToolbarSummarySync() {
  const button = document.getElementById('jrSummaryPlus');
  if (button) button.disabled = !(journal.data && Array.isArray(journal.data.staff) && journal.data.staff.length);
}
async function jrSummaryLoad(date) {
  const selected = String(date || document.getElementById('jrDate')?.value || '');
  const request = ++jrSummaryRequest;
  jrSummaryRender({ loading: true, date: selected });
  try {
    const data = await jrApi(`day-summary?${new URLSearchParams({ date: selected })}`);
    const current = String(document.getElementById('jrDate')?.value || '');
    if (request !== jrSummaryRequest || current !== selected) return;
    if (String(data?.date || '') !== selected) {
      jrSummaryRender({ error: 'Сводка пришла для другой даты. Повторите загрузку.', date: selected });
      return;
    }
    jrSummaryRender(data);
  } catch (error) {
    const current = String(document.getElementById('jrDate')?.value || '');
    if (request !== jrSummaryRequest || current !== selected) return;
    jrSummaryRender({ error: error?.message || 'Не удалось загрузить сводку.', date: selected });
  }
}
function jrToolbarInit() {
  if (!(journal.statusFilter instanceof Set)) journal.statusFilter = new Set([0, 1, -1, 2]);
  jrToolbarSync();
  jrSummaryRender();
  jrToolbarSummarySync();
  if (typeof document.addEventListener !== 'function') return;
  document.addEventListener('click', event => {
    const button = journal.toolbarPopupButton;
    const popup = button && document.getElementById(button.getAttribute('aria-controls'));
    if (button && !button.contains(event.target) && !popup?.contains(event.target)) jrToolbarPopupClose(false);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') jrToolbarPopupClose(true); });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', jrToolbarInit, { once: true });
  else jrToolbarInit();
}
