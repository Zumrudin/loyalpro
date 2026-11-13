// Журнал записи: формы создания/переноса, поиск клиента, вопрос при закрытии. Общая глобальная область с journal.js.
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
    <label class="jr-notify"><input type="checkbox" id="jrCreateNoNotify"> Не уведомлять клиента</label>
    <div id="jrClientSummary" class="jr-hint"></div><h4 id="jrClientsTitle">Последние клиенты</h4><div id="jrClientResults" aria-live="polite"></div></aside>`;
}
async function jrLoadClients(query = '', onPick = jrSelectClient) {
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
    jrEl('jrClientResults').querySelectorAll('[data-client-index]').forEach(button => { button.onclick = () => onPick(journal.clientResults[Number(button.dataset.clientIndex)]); });
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
  // «Записать повторно» passes date:'' — the date is chosen anew.
  jrEl('jrFormDate').value = record?.date || (preset.date !== undefined ? preset.date : jrEl('jrDate').value);
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
  if (!record && Array.isArray(preset.serviceIds) && preset.serviceIds.length) {
    for (const o of Array.from(jrEl('jrServices').options)) if (o) o.selected = preset.serviceIds.includes(Number(o.value));
    jrRenderServiceChoices();
  }
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
    if (preset.client?.phone) jrSelectClient(preset.client);
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
  if (!record) Object.assign(draft, { serviceSource: journal.data.serviceSource, ...(journal.data.serviceSource === 'internal' ? {lines:jrSelectedLines()} : {}), serviceIds: Array.from(jrEl('jrServices').selectedOptions).map(o => Number(o.value)), clientName: journal.selectedClient?.name || [jrEl('jrSurname').value,jrEl('jrName').value,jrEl('jrPatronymic').value].map(s => s.trim()).filter(Boolean).join(' '), clientPhone: journal.selectedClient?.phone || jrEl('jrPhone').value, comment: jrEl('jrComment').value, ...(jrEl('jrCreateNoNotify')?.checked ? { notifyClient: false } : {}) });
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
