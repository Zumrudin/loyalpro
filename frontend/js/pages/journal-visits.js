// Журнал записи: «История посещений» клиента. Общая глобальная область с journal.js (префикс jrVh).
// Visits (past and future) and purchases of cosmetics, certificates and
// abonements, from LoyalPro data only (GET clients/visits). A visit line opens
// its card, a purchase opens the payment of its record.
const JR_VH_STATUS = { 0: ['Ожидание', 'wait'], 1: ['Пришёл', 'came'], '-1': ['Не пришёл', 'noshow'], 2: ['Подтвердил', 'confirmed'] };
const JR_VH_PURCHASE = { goods: 'Косметика', certificate: 'Сертификат', abonement: 'Абонемент' };
const JR_VH_CONSUMABLES_SHOWN = 2;

function jrVhDay(date) {
  if (!date) return 'Дата не указана';
  const s = new Date(date + 'T12:00:00+03:00').toLocaleDateString('ru', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
  return s.replace(/^(\d+)\s+(\S)/, (_, d, c) => d + ' ' + c.toUpperCase());
}
function jrVhStaffName(e) {
  if (e.staffName) return e.staffName;
  const s = (journal.data?.staff || []).find(x => Number(x.id) === Number(e.staffId));
  return s?.name || (e.kind === 'purchase' ? 'Продажа' : 'Сотрудник');
}
const jrVhInitials = name => String(name).split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();
// Which entries and lines the filter keeps (all / visits only / purchases only),
// each with its index in the loaded list (buttons address entries by it).
function jrVhFilter(entries, filter) {
  const all = (entries || []).map((e, i) => [e, i]);
  if (filter === 'visits') return all.filter(([e]) => e.kind === 'visit').map(([e, i]) => [{ ...e, purchases: [] }, i]);
  if (filter === 'purchases') return all.filter(([e]) => (e.purchases || []).length).map(([e, i]) => [{ ...e, services: [] }, i]);
  return all;
}
function jrVhStatus(e) {
  if (e.kind !== 'visit') return '<span class="jr-vh-status jr-vh-sale" title="Покупка">₽</span>';
  const [label, cls] = JR_VH_STATUS[e.attendance] || JR_VH_STATUS[0];
  const mark = { wait: jrIcon('clock'), came: jrIcon('plus'), noshow: '−', confirmed: jrIcon('check') }[cls];
  return `<span class="jr-vh-status jr-vh-${cls}" title="${label}" aria-label="${label}">${mark}</span>`;
}
function jrVhLines(e, i) {
  const open = journal.visits?.expanded?.has(i);
  const services = (e.services || []).map(s => {
    const cons = s.consumables || [];
    const shown = open ? cons : cons.slice(0, JR_VH_CONSUMABLES_SHOWN);
    return `<div class="jr-vh-line"><button type="button" class="jr-vh-link" data-vh-open="${e.recordId}" title="Открыть визит">${jrIcon('check')}<span>${jrEscape(s.title)}${s.quantity > 1 ? ` <small>× ${jrEscape(s.quantity)}</small>` : ''}</span></button><span class="jr-vh-money">${jrRub(s.cost)}</span><span class="jr-vh-money">${jrRub(s.paid)}</span></div>`
      + shown.map(c => `<div class="jr-vh-cons">${jrEscape(c.title)}${c.quantity ? ', ' + jrEscape(c.quantity) : ''}, ${jrEscape(Number(c.cost).toLocaleString('ru-RU'))} ₽</div>`).join('')
      + (cons.length > JR_VH_CONSUMABLES_SHOWN ? `<button type="button" class="jr-vh-more" data-vh-more="${i}">${open ? 'Свернуть' : 'Показать полностью'}</button>` : '');
  });
  const purchases = (e.purchases || []).map(p => {
    const label = `<small class="jr-vh-tag">${jrEscape(JR_VH_PURCHASE[p.type] || 'Покупка')}</small>${jrEscape(p.title)}${p.quantity ? ` <small>· ${jrEscape(p.quantity)}</small>` : ''}`;
    const link = e.recordId != null
      ? `<button type="button" class="jr-vh-link" data-vh-pay="${e.recordId}" title="Открыть оплату записи">${jrIcon('box')}<span>${label}</span></button>`
      : `<span class="jr-vh-link jr-vh-static" title="Продажа вне визита">${jrIcon('box')}<span>${label}<small class="jr-vh-note">Продажа вне визита</small></span></span>`;
    return `<div class="jr-vh-line">${link}<span class="jr-vh-money">${jrRub(p.amount)}</span><span class="jr-vh-money">${jrRub(p.amount)}</span></div>`;
  });
  return services.join('') + purchases.join('') || '<p class="jr-hint">Услуги не указаны</p>';
}
function jrVhEntry(e, i) {
  const name = jrVhStaffName(e);
  const visit = e.kind === 'visit';
  const who = `<div class="jr-vh-staff"><span class="jr-staff-avatar">${jrEscape(jrVhInitials(name))}</span><div><strong>${jrEscape(name)}</strong><small>${jrEscape(e.time || '')}${visit ? ` <button type="button" class="jr-vh-details" data-vh-open="${e.recordId}">Подробнее ›</button>` : ''}</small></div></div>`;
  const repeat = visit && (e.services || []).length ? `<button type="button" class="btn btn-sec jr-vh-repeat" data-vh-repeat="${i}" title="Повторить услуги" aria-label="Повторить услуги">${jrIcon('repeat')}</button>` : '<span></span>';
  return `<div class="jr-vh-entry">${who}${jrVhStatus(e)}<div class="jr-vh-lines">${jrVhLines(e, i)}</div>${repeat}</div>`;
}
function jrVhHtml(data, filter) {
  const groups = [];
  jrVhFilter(data.entries, filter).forEach(([e, i]) => {
    const last = groups[groups.length - 1];
    if (last && last.date === e.date) last.items.push([e, i]); else groups.push({ date: e.date, items: [[e, i]] });
  });
  const body = groups.length ? groups.map(g => `<section class="jr-vh-day"><h4><span>${jrEscape(jrVhDay(g.date))}</span><small>${jrEscape(data.salonName || '')}</small></h4>${g.items.map(([e, i]) => jrVhEntry(e, i)).join('')}</section>`).join('')
    : `<p class="jr-hint">${filter === 'purchases' ? 'Покупок нет.' : filter === 'visits' ? 'Визитов нет.' : 'Визитов и покупок нет.'}</p>`;
  return `<div class="jr-vh-toolbar"><select id="jrVhFilter" aria-label="Что показать"><option value="all"${filter === 'all' ? ' selected' : ''}>Показать все записи</option><option value="visits"${filter === 'visits' ? ' selected' : ''}>Только визиты</option><option value="purchases"${filter === 'purchases' ? ' selected' : ''}>Только покупки</option></select>${journal.visits?.fromId != null ? '<button type="button" class="btn btn-sec" id="jrVhBack">К записи</button>' : ''}</div>
    <div class="jr-vh-table"><div class="jr-vh-head"><span>Сотрудник</span><span>Статус</span><span class="jr-vh-line"><span>Услуга</span><span class="jr-vh-money">Стоимость</span><span class="jr-vh-money">Оплачено</span></span><span></span></div>${body}</div>`;
}
function jrVhRender() {
  const v = journal.visits;
  if (!v?.data) return;
  jrEl('jrModalBody').innerHTML = jrVhHtml(v.data, v.filter);
  const body = jrEl('jrModalBody');
  jrEl('jrVhFilter').onchange = e => { v.filter = e.target.value; jrVhRender(); };
  if (jrEl('jrVhBack')) jrEl('jrVhBack').onclick = () => jrOpen(v.fromId);
  body.querySelectorAll('[data-vh-open]').forEach(b => b.onclick = () => jrOpen(Number(b.dataset.vhOpen)));
  body.querySelectorAll('[data-vh-pay]').forEach(b => b.onclick = () => jrOpenPayment(Number(b.dataset.vhPay)));
  body.querySelectorAll('[data-vh-more]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.vhMore);
    if (v.expanded.has(i)) v.expanded.delete(i); else v.expanded.add(i);
    jrVhRender();
  });
  body.querySelectorAll('[data-vh-repeat]').forEach(b => b.onclick = () => {
    const e = v.data.entries[Number(b.dataset.vhRepeat)];
    if (e) jrRebook({ staffId: e.staffId, services: e.services, clientName: v.clientName, clientPhone: v.phone });
  });
}
// From the card: unsaved card edits are not dropped silently (as «Записать повторно»).
async function jrOpenVisits(r) {
  const kind = journal.session?.edit ? jrUnsavedKind() : null;
  if (kind) return jrAskClose(kind);
  const phone = String(r?.clientPhone || '').replace(/\D/g, '');
  const request = ++journal.modalRequest;
  journal.slotRequest++; journal.draft = null; journal.session = null; journal.payment = null;
  journal.visits = { fromId: r?.id ?? null, phone, clientName: r?.clientName || '', filter: 'all', expanded: new Set(), data: null };
  jrShowModal('История посещений', true);
  jrEl('jrModal').className = 'jr-dialog jr-dialog-wide jr-dialog-visits';
  if (!phone) { jrEl('jrModalBody').innerHTML = '<p class="jr-hint">Телефон клиента неизвестен — историю показать нельзя.</p>'; return false; }
  try {
    const data = await jrApi('clients/visits?' + new URLSearchParams({ phone }));
    if (request !== journal.modalRequest) return false;
    journal.visits.data = data;
    jrVhRender();
    return true;
  } catch (e) {
    if (request !== journal.modalRequest) return false;
    jrMessage(e.message);
    jrEl('jrModalBody').innerHTML = '<button type="button" class="btn btn-sec" id="jrVhReload">Повторить загрузку</button>';
    jrEl('jrVhReload').onclick = () => jrOpenVisits(r);
    return false;
  }
}
