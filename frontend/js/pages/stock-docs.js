const STOCK_KINDS = {
  receipt: 'Приход',
  writeoff: 'Списание',
  move: 'Перемещение',
  sale: 'Продажа',
  inventory: 'Инвентаризация',
  consumable: 'Расходники',
  opening: 'Начальные остатки',
};
const _stockDoc = {
  request: 0, operationsRequest: 0, busy: false, kind: null, goods: [], lines: [], page: 1,
  services: [], servicesLoaded: false, appliedQuery: '', appliedFilters: '',
};
function stockDocBadge(d) {
  return `<span class="stock-badge">${d.origin === 'yclients' ? 'YClients' : 'LoyalPro'}${d.status === 'cancelled' ? ' · Отменён' : d.status === 'draft' ? ' · Черновик' : ''}</span>`;
}
function stockLinesTotal(lines) {
  return lines.reduce(
    (sum, l) => sum + Math.round(Number(l.qty) * Number(l.costPerUnit) * (1 - Number(l.discount || 0) / 100) * 100),
    0,
  );
}
function stockOptions(rows, selected, empty = 'Выберите') {
  return (
    `<option value="">${stockEsc(empty)}</option>` +
    rows
      .map(
        (r) =>
          `<option value="${stockEsc(r.id)}" ${String(r.id) === String(selected) ? 'selected' : ''}>${stockEsc(r.title || r.name)}</option>`,
      )
      .join('')
  );
}
function stockSelect(id, label, rows, selected, empty) {
  return `<label>${stockEsc(label)}<select id="${id}">${stockOptions(rows, selected, empty)}</select></label>`;
}
function stockLocalTime() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(' ', 'T');
}
async function stockEnsureDictionaries() {
  _stock.dictionaries = await stockApi('/dictionaries');
  return _stock.dictionaries;
}
function stockOpsMonthPeriod() {
  const to = stockToday();
  const [year, month, day] = to.split('-').map(Number);
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  const previousLastDay = new Date(Date.UTC(previousYear, previousMonth, 0)).getUTCDate();
  return { from: `${previousYear}-${String(previousMonth).padStart(2, '0')}-${String(Math.min(day, previousLastDay)).padStart(2, '0')}`, to };
}
function stockResetOperations() {
  ++_stockDoc.operationsRequest;
  ++_stockDoc.request;
  _stockDoc.services = [];
  _stockDoc.servicesLoaded = false;
  _stockDoc.appliedQuery = '';
  _stockDoc.appliedFilters = '';
  _stockDoc.page = 1;
  const tab = stockEl('stockTab-docs');
  if (tab) tab.innerHTML = '';
  const modal = stockEl('stockDocModal');
  if (modal?.open && typeof modal.close === 'function') modal.close();
}
function stockOpsSetExportDisabled(disabled) {
  const button = typeof document.querySelector === 'function' ? document.querySelector('[onclick="stockExportOperations()"]') : null;
  if (button) button.disabled = !!disabled;
}
function stockOpsPrepareOptions() {
  const payment = stockEl('stockOpsPaymentStatus');
  if (payment)
    payment.innerHTML = '<option value="">Все статусы оплаты</option>' +
      [
        ['paid', 'Оплачено'], ['unpaid', 'Не оплачено'], ['partial', 'Частично оплачено'],
        ['pending', 'Ожидает оплаты'], ['failed', 'Ошибка оплаты'], ['cancelled', 'Отменено'],
        ['not_applicable', 'Не применимо'], ['unknown', 'Нет данных'],
      ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  if (typeof document.querySelector !== 'function') return;
  const menu = document.querySelector('.stock-operations-menu');
  const menuList = menu?.querySelector('div');
  if (menu?.parentElement) menu.parentElement.classList.add('stock-operations-menu-wrap');
  if (menuList) menuList.classList.add('stock-operations-menu-list');
  const show = document.querySelector('#stockOperationsForm button[type="submit"]');
  if (show) show.classList.add('stock-operations-show');
  const pageSize = stockEl('stockOpsLimit')?.closest?.('label');
  if (pageSize) pageSize.classList.add('stock-operations-page-size');
  const count = stockEl('stockOperationsCount')?.parentElement;
  if (count) count.classList.add('stock-operations-count');
}
function stockOpsShell() {
  const period = stockOpsMonthPeriod();
  const kinds = Object.entries(STOCK_KINDS).map(([id, title]) => ({ id, title }));
  return `<section class="stock-operations" aria-labelledby="stockOperationsTitle"><header class="stock-operations-head"><div><div class="stock-breadcrumb">Склад</div><h1 id="stockOperationsTitle">Складские операции</h1></div><div class="stock-operations-actions"><button type="button" class="btn btn-sec" onclick="stockExportOperations()" disabled>Выгрузить в Excel</button><details class="stock-operations-menu"><summary class="btn btn-pri">Операции с товарами</summary><div><button type="button" onclick="stockSaleOpen()">Продажа товара</button><button type="button" onclick="stockDocumentOpen('receipt')">Приход товара</button><button type="button" onclick="stockDocumentOpen('writeoff')">Списание товара</button><button type="button" onclick="stockDocumentOpen('move')">Перемещение товара</button></div></details></div></header><form id="stockOperationsForm" class="stock-operations-filters" onsubmit="event.preventDefault();stockLoadDocs(1)"><div class="stock-operations-filter-grid">${stockInput('stockOpsFrom', 'С', period.from, 'date')}${stockInput('stockOpsTo', 'По', period.to, 'date')}${stockSelect('stockOpsKind', 'Тип операции', kinds, '', 'Все типы операций')}${stockInput('stockOpsCounterparty', 'Контрагент', '', 'search', 'maxlength="100" placeholder="Поиск контрагента"')}${stockSelect('stockOpsStorage', 'Склад', _stock.dictionaries.storages, '', 'Все склады')}${stockInput('stockOpsSearch', 'Товар', '', 'search', 'maxlength="100" placeholder="Название или артикул"')}<label>Услуга с расходником<select id="stockOpsService"><option value="">Все услуги</option></select></label>${stockInput('stockOpsClient', 'Клиент', '', 'search', 'maxlength="100" placeholder="Имя или телефон"')}${stockInput('stockOpsDocumentNumber', 'Номер документа', '', 'search', 'maxlength="100" placeholder="Номер документа"')}<label>Статус оплаты<select id="stockOpsPaymentStatus"><option value="">Все статусы оплаты</option><option value="paid">Оплачено</option><option value="unpaid">Не оплачено</option><option value="not_applicable">Не применимо</option></select></label></div><details class="stock-operations-extra"><summary>Дополнительные фильтры</summary><div class="stock-operations-extra-grid"><label>Источник<select id="stockOpsOrigin"><option value="">Все источники</option><option value="loyalpro">LoyalPro</option><option value="yclients">YClients</option></select></label><label>Статус документа<select id="stockOpsStatus"><option value="">Все статусы</option><option value="posted">Проведён</option><option value="draft">Черновик</option><option value="cancelled">Отменён</option></select></label></div></details><footer class="stock-operations-filter-footer"><label>Результатов на странице<select id="stockOpsLimit"><option value="25" selected>25</option><option value="50">50</option><option value="100">100</option></select></label><button type="submit" class="btn btn-pri">Показать</button></footer></form><p id="stockOperationsError" class="stock-operations-error" role="alert"></p><div class="stock-operations-meta"><span>Найдено <strong id="stockOperationsCount">0</strong></span></div><div id="stockOperationsList" aria-live="polite"></div></section>`;
}
function stockOpsParams(page) {
  const params = new URLSearchParams({ page: String(page), limit: stockEl('stockOpsLimit').value || '25' });
  const fields = [
    ['from', 'stockOpsFrom'], ['to', 'stockOpsTo'], ['kind', 'stockOpsKind'], ['origin', 'stockOpsOrigin'],
    ['status', 'stockOpsStatus'], ['storage', 'stockOpsStorage'], ['search', 'stockOpsSearch'],
    ['counterparty', 'stockOpsCounterparty'], ['client_search', 'stockOpsClient'], ['document_number', 'stockOpsDocumentNumber'],
    ['service', 'stockOpsService'], ['payment_status', 'stockOpsPaymentStatus'],
  ];
  for (const [key, id] of fields) {
    const value = stockEl(id).value.trim();
    if (value) params.set(key, value);
  }
  return params;
}
async function stockOpsLoadServices(request) {
  if (_stockDoc.servicesLoaded) return;
  const data = await stockApi('/operations/services');
  if (request !== _stockDoc.operationsRequest) return;
  _stockDoc.services = Array.isArray(data.services) ? data.services : [];
  _stockDoc.servicesLoaded = true;
  const select = stockEl('stockOpsService');
  if (select)
    select.innerHTML = '<option value="">Все услуги</option>' +
      _stockDoc.services.map((service) => `<option value="${Number(service.id)}">${stockEsc(service.title || 'Услуга №' + Number(service.id))}</option>`).join('');
}
async function stockLoadDocs(page = 1, useAppliedFilters = false) {
  const el = stockEl('stockTab-docs');
  if (!stockEl('stockOperationsList')) {
    if (!(_stock.dictionaries.storages || []).length) await stockEnsureDictionaries();
    el.innerHTML = stockOpsShell();
    stockOpsPrepareOptions();
  }
  const request = ++_stockDoc.operationsRequest;
  _stockDoc.page = page;
  stockEl('stockOperationsError').textContent = '';
  stockEl('stockOperationsList').innerHTML = '<p class="empty">Загрузка…</p>';
  _stockDoc.appliedQuery = '';
  const query = useAppliedFilters && _stockDoc.appliedFilters ? new URLSearchParams(_stockDoc.appliedFilters) : stockOpsParams(page);
  query.set('page', String(page));
  stockOpsSetExportDisabled(true);
  try {
    const [data, servicesError] = await Promise.all([stockApi('/operations?' + query), stockOpsLoadServices(request).then(() => null, (e) => e)]);
    if (request !== _stockDoc.operationsRequest) return;
    const operations = Array.isArray(data.operations) ? data.operations : [];
    const total = Number(data.total) || 0;
    const limit = Number(data.limit) || Number(query.get('limit')) || 25;
    _stockDoc.appliedQuery = query.toString();
    _stockDoc.appliedFilters = query.toString();
    stockEl('stockOperationsCount').textContent = total.toLocaleString('ru-RU');
    stockEl('stockOperationsList').innerHTML = stockOperationsTable(operations) + stockOperationsPagination(page, total, limit);
    stockOpsSetExportDisabled(false);
    if (servicesError) stockEl('stockOperationsError').textContent = 'Не удалось загрузить список услуг. Повторите попытку.';
  } catch (e) {
    if (request !== _stockDoc.operationsRequest) return;
    stockEl('stockOperationsCount').textContent = '0';
    stockEl('stockOperationsList').innerHTML = '';
    stockEl('stockOperationsError').textContent = e.message;
  }
}
function stockOpsNumber(value) {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n)) return 'Нет данных';
  if (n > 0 && n < 0.0001) return n.toLocaleString('ru-RU', { maximumSignificantDigits: 8 });
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 8 });
}
function stockOpsQty(operation, field = 'qty_base') {
  if (operation[field] == null || operation[field] === '') return 'Нет данных';
  const quantity = Number(operation[field]);
  if (!Number.isFinite(quantity)) return 'Нет данных';
  const sign = Number(operation.qty_base) < 0 ? '−' : '';
  return sign + stockOpsNumber(quantity) + ' ' + stockEsc(field === 'qty_pack' ? operation.unit_title || operation.service_unit_title || 'ед.' : operation.service_unit_title || operation.unit_title || 'ед.');
}
function stockOpsQuantity(operation) {
  const base = stockOpsQty(operation);
  if (operation.qty_pack == null || operation.qty_pack === '') return base;
  const pack = Number(operation.qty_pack);
  const unit = String(operation.unit_title || '');
  const serviceUnit = String(operation.service_unit_title || '');
  if (!Number.isFinite(pack) || !unit || unit === serviceUnit || Math.abs(pack) === Math.abs(Number(operation.qty_base))) return base;
  return stockOpsQty(operation, 'qty_pack') + '<br><small>(' + base + ')</small>';
}
function stockOpsCost(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? 'Нет данных' : stockMoney(value);
}
function stockOpsVisit(recordId, visitAt) {
  if (!Number.isSafeInteger(Number(recordId)) || Number(recordId) <= 0) return '—';
  return `<button type="button" class="stock-link" onclick="stockOpenOperationVisit(${Number(recordId)})">${stockEsc(visitAt ? stockDate(visitAt) : 'Визит №' + Number(recordId))}</button>`;
}
function stockOperationsTable(rows) {
  if (!rows.length) return '<p class="empty">Операций по заданным фильтрам нет</p>';
  const historicalTitle = 'По сохранённым данным; пересчитывается при исправлении истории';
  return '<div class="stock-operations-table-wrap"><table class="stock-table stock-operations-table"><thead><tr><th aria-label="Действия">#</th><th>Дата</th><th>№ документа</th><th>Поставщик/получатель</th><th>Тип операции</th><th>Склад</th><th>Комментарий</th><th>Товар</th><th>Количество</th><th>Себестоимость</th><th>Остаток на складе</th><th>Визит</th><th>История изменений</th></tr></thead><tbody>' +
    rows.map((o) => {
      const documentId = Number(o.document_id);
      const goodId = Number(o.good_row_id);
      const hasDocument = Number.isSafeInteger(documentId) && documentId > 0;
      const hasGood = Number.isSafeInteger(goodId) && goodId > 0;
      const type = STOCK_KINDS[o.kind] || o.kind || 'Операция';
      const status = o.deleted_at ? ' · Удалён' : o.status === 'cancelled' ? ' · Отменён' : o.status === 'draft' ? ' · Черновик' : '';
      return `<tr><td data-label="Действия">${hasDocument ? `<button type="button" class="stock-link" aria-label="Открыть документ № ${stockEsc(o.document_number || documentId)}" onclick="stockOpenDocument(${documentId})">⚙</button>` : '—'}</td><td data-label="Дата">${stockEsc(stockDate(o.occurred_at))}</td><td data-label="№ документа">${hasDocument ? `<button type="button" class="stock-link" onclick="stockOpenDocument(${documentId})">${stockEsc(o.document_number || documentId)}</button>` : stockEsc(o.document_number || '—')}</td><td data-label="Поставщик/получатель">${stockEsc(o.counterparty_name || '—')}</td><td data-label="Тип операции">${stockEsc(type + status)}<br><small>${stockEsc(o.origin === 'yclients' ? 'YClients' : 'LoyalPro')}</small></td><td data-label="Склад">${stockEsc(o.storage_title || '—')}</td><td data-label="Комментарий">${stockEsc(o.comment || '—')}</td><td data-label="Товар">${hasGood ? `<button type="button" class="stock-link" onclick="stockOpenGood(${goodId})">${stockEsc(o.good_title || 'Товар')}</button>` : stockEsc(o.good_title || 'Нет данных')}${o.article ? '<br><small>' + stockEsc(o.article) + '</small>' : ''}</td><td data-label="Количество">${stockOpsQuantity(o)}</td><td data-label="Себестоимость" title="${historicalTitle}">${stockEsc(stockOpsCost(o.cost_basis))}</td><td data-label="Остаток на складе" title="${historicalTitle}">${o.balance_after == null ? 'Нет данных' : stockOpsQty({ ...o, qty_base: o.balance_after })}</td><td data-label="Визит">${stockOpsVisit(o.record_id, o.visit_at)}</td><td data-label="История изменений">${hasDocument ? `<button type="button" class="stock-link" onclick="stockOpenOperationHistory(${documentId})">Показать</button>` : '—'}</td></tr>`;
    }).join('') + '</tbody></table></div>';
}
function stockOperationsPagination(page, total, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return `<nav class="stock-operations-pagination" aria-label="Страницы операций"><button type="button" ${page <= 1 ? 'disabled' : ''} onclick="stockLoadDocs(${page - 1},true)">Назад</button><span>Страница ${page} из ${pages}</span><button type="button" ${page >= pages ? 'disabled' : ''} onclick="stockLoadDocs(${page + 1},true)">Далее</button></nav>`;
}
function stockOpenOperationVisit(recordId) {
  stockDocumentClose();
  navTo('journal');
  if (typeof jrOpen === 'function') jrOpen(Number(recordId));
}
function stockOpsHistoryAction(action) {
  return {
    document_created: 'Документ создан', document_changed: 'Документ изменён', document_posted: 'Документ проведён',
    document_cancelled: 'Документ отменён', movement_created: 'Движение добавлено', movement_changed: 'Движение изменено',
    movement_deleted: 'Движение удалено', movement_restored: 'Движение восстановлено',
  }[String(action || '').replace(/_known$/, '')] || action || '—';
}
function stockOpsHistoryValue(value, field) {
  const values = {
    posted: 'Проведён', draft: 'Черновик', cancelled: 'Отменён', paid: 'Оплачено', unpaid: 'Не оплачено',
    partial: 'Частично оплачено', pending: 'Ожидает оплаты', failed: 'Ошибка оплаты', not_applicable: 'Не применимо',
    unknown: 'Нет данных', loyalpro: 'LoyalPro', yclients: 'YClients', webhook: 'Вебхук YClients', reconcile: 'Сверка YClients',
    backfill: 'Импорт истории', receipt: 'Приход', writeoff: 'Списание', move: 'Перемещение', sale: 'Продажа',
    inventory: 'Инвентаризация', consumable: 'Расходники',
  };
  if (field === 'unit_type' && String(value) === '1') return 'Единица продажи';
  if (field === 'unit_type' && String(value) === '2') return 'Единица списания';
  return values[String(value)] || (value == null || value === '' ? 'не указано' : value === true ? 'да' : value === false ? 'нет' : String(value));
}
function stockOpsHistoryChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return changes ? 'Изменения документа' : '—';
  const labels = {
    kind: 'Тип операции', status: 'Статус документа', storage_id: 'Склад', comment: 'Комментарий',
    origin: 'Источник', counterparty_name: 'Поставщик/получатель', occurred_at: 'Дата операции', doc_date: 'Дата операции',
    document_number: 'Номер документа', total_cost: 'Сумма документа', cost: 'Сумма', cost_basis: 'Себестоимость',
    source: 'Источник', record_id: 'Визит', client_id: 'Клиент', good_row_id: 'Товар', to_storage_id: 'Склад назначения',
    supplier_id: 'Поставщик', service_yc_id: 'Услуга', yclients_client_link_changed: 'Связь с клиентом', comment_changed: 'Комментарий',
    qty_base: 'Количество', qty: 'Количество', unit_type: 'Единица измерения', cost_per_unit: 'Цена за единицу',
    discount: 'Скидка', deleted_at: 'Удаление', payment_status: 'Статус оплаты',
  };
  const idFields = new Set(['storage_id', 'to_storage_id', 'supplier_id', 'record_id', 'client_id', 'good_row_id', 'service_yc_id', 'yclients_client_link_changed']);
  const rows = Object.entries(changes).map(([field, change]) => {
    const label = labels[field] || 'Данные документа';
    if (field === 'comment' || field === 'comment_changed' || idFields.has(field)) return label + ' изменён';
    const from = change && typeof change === 'object' ? change.from : undefined;
    const to = change && typeof change === 'object' ? change.to : change;
    return label + ': ' + stockOpsHistoryValue(from, field) + ' → ' + stockOpsHistoryValue(to, field);
  });
  return rows.length ? rows.join('; ') : '—';
}
async function stockOpenOperationHistory(documentId) {
  const request = ++_stockDoc.request;
  try {
    const data = await stockApi('/documents/' + Number(documentId) + '/history');
    if (request !== _stockDoc.request) return;
    const events = Array.isArray(data.events) ? data.events : [];
    stockEl('stockDocBody').innerHTML = `<h3>История изменений</h3>${data.history_since ? `<p>История ведётся с ${stockEsc(stockDate(data.history_since))}</p>` : ''}${data.truncated ? '<p>Показаны последние 200 изменений.</p>' : ''}${events.length ? `<table class="stock-table"><thead><tr><th>Дата</th><th>Действие</th><th>Кто</th><th>Источник</th><th>Изменения</th></tr></thead><tbody>${events.map((event) => `<tr><td data-label="Дата">${stockEsc(stockDate(event.occurred_at))}</td><td data-label="Действие">${stockEsc(stockOpsHistoryAction(event.action))}${event.known ? '<br><small>По данным документа; полная история не сохранена</small>' : ''}</td><td data-label="Кто">${stockEsc(event.actor_name || '—')}</td><td data-label="Источник">${stockEsc(stockOpsHistoryValue(event.source, 'source'))}</td><td data-label="Изменения">${stockEsc(stockOpsHistoryChanges(event.changes))}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">История изменений пока не записана.</p>'}`;
    stockEl('stockDocError').textContent = '';
    stockEl('stockDocSave').hidden = true;
    stockEl('stockDocModal').showModal();
  } catch (e) {
    if (request === _stockDoc.request) stockEl('stockOperationsError').textContent = e.message;
  }
}
async function stockExportOperations() {
  const request = _stockDoc.operationsRequest;
  const button = typeof document.querySelector === 'function' ? document.querySelector('[onclick="stockExportOperations()"]') : null;
  if (button) button.disabled = true;
  try {
    if (!_stockDoc.appliedQuery) throw new Error('Сначала примените фильтры.');
    const response = await fetch('/api/stock/operations/export?' + _stockDoc.appliedQuery, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!response.ok) {
      let message = 'Не удалось выгрузить операции.';
      try { message = (await response.json()).error || message; } catch (_) {}
      throw new Error(message);
    }
    const blob = await response.blob();
    if (request !== _stockDoc.operationsRequest) return;
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = 'skladskie-operacii.xlsx';
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    stockEl('stockOperationsError').textContent = e.message;
  } finally {
    if (button && request === _stockDoc.operationsRequest && _stockDoc.appliedQuery) button.disabled = false;
  }
}
function stockDocsTable(rows) {
  return rows.length
    ? '<table class="stock-table"><thead><tr><th>Дата</th><th>Документ</th><th>Склад</th><th>Сумма</th></tr></thead><tbody>' +
        rows
          .map(
            (d) =>
              `<tr><td data-label="Дата">${stockDate(d.doc_date)}</td><td data-label="Документ"><button class="stock-link" onclick="stockOpenDocument(${Number(d.id)})">${STOCK_KINDS[d.kind] || 'Документ'} №${Number(d.id)}</button>${stockDocBadge(d)}</td><td data-label="Склад">${stockEsc(d.storage_title)}${d.to_storage_title ? ' → ' + stockEsc(d.to_storage_title) : ''}</td><td data-label="Сумма">${stockMoney(d.total_cost)}</td></tr>`,
          )
          .join('') +
        '</tbody></table>'
    : '<p class="empty">Операций нет</p>';
}
function stockDocumentHtml(d) {
  return `<h3>${STOCK_KINDS[d.kind] || 'Документ'} №${Number(d.id)}</h3>${stockDocBadge(d)}<p>${stockDate(d.doc_date)} · ${stockMoney(d.total_cost)}</p><p>${stockEsc(d.comment)}</p><p>${stockEsc(d.cancel_reason)}</p><table class="stock-table"><thead><tr><th>Товар</th><th>Количество</th><th>Сумма</th></tr></thead><tbody>${(d.lines || []).map((l) => `<tr><td data-label="Товар">${stockEsc(l.title || l.good_title || 'Товар №' + l.good_row_id)}</td><td data-label="Количество">${stockEsc(stockFmtQty(l.qty_base, l.unit_equals, l.unit, l.service_unit))}</td><td data-label="Сумма">${stockMoney(l.cost)}</td></tr>`).join('')}</tbody></table><p>${(d.payments || []).map((p) => `${p.method === 'cash' ? 'Наличные' : 'Карта'}: ${stockMoney(p.amount)}`).join(' · ')}</p>${d.record_id ? `<button type="button" onclick="stockDocumentClose();navTo('journal');jrOpen(${Number(d.record_id)})">Открыть запись</button>` : ''}${d.origin === 'loyalpro' && d.status === 'posted' && ['receipt', 'writeoff', 'move', 'sale', 'inventory'].includes(d.kind) ? `<label>Причина отмены<textarea id="stockCancelReason" maxlength="500"></textarea></label><button type="button" onclick="stockCancelDocument(${Number(d.id)})">Отменить документ</button>` : ''}`;
}
function stockDocumentClose() {
  if (!_stockDoc.busy) {
    ++_stockDoc.request;
    stockEl('stockDocModal').close();
  }
}
async function stockOpenDocument(id) {
  if (_stockDoc.busy) return;
  const req = ++_stockDoc.request;
  try {
    const d = await stockApi('/documents/' + Number(id));
    if (req !== _stockDoc.request) return;
    stockEl('stockDocBody').innerHTML = stockDocumentHtml(d);
    stockEl('stockDocError').textContent = '';
    stockEl('stockDocSave').hidden = true;
    stockEl('stockDocModal').showModal();
  } catch (e) {
    stockEl('stockStatus').textContent = e.message;
  }
}
async function stockCancelDocument(id) {
  if (_stockDoc.busy) return;
  const reason = stockEl('stockCancelReason').value.trim();
  if (!reason) {
    stockEl('stockDocError').textContent = 'Укажите причину отмены.';
    return;
  }
  if (!confirm('Отменить документ и его движения?')) return;
  _stockDoc.busy = true;
  try {
    await stockApi('/documents/' + Number(id) + '/cancel', { reason });
    stockEl('stockDocModal').close();
    await stockRefreshAfterWrite();
  } catch (e) {
    stockEl('stockDocError').textContent = e.message;
  } finally {
    _stockDoc.busy = false;
  }
}
async function stockRefreshAfterWrite() {
  if (_stock.tab === 'docs') await stockLoadDocs(_stockDoc.page);
  if (['goods', 'balances'].includes(_stock.tab)) await stockLoadGoods();
  await stockLoadCounters();
}
function stockLinesHtml(prefix, lines, goods) {
  return (
    `<datalist id="${prefix}Goods">${goods.map((g) => `<option value="${Number(g.id)} — ${stockEsc(g.title)}"></option>`).join('')}</datalist>` +
    lines
      .map((l, i) => {
        const g = goods.find((g) => Number(g.id) === Number(l.goodRowId));
        return `<div class="stock-line" data-stock-line="${i}"><label>Товар<input data-field="good" list="${prefix}Goods" value="${g ? Number(g.id) + ' — ' + stockEsc(g.title) : ''}" required oninput="stockSearchGoods('${prefix}',this.value)" onchange="stockLineGood('${prefix}',${i},this.value)"></label><label>Количество<input data-field="qty" type="number" min="0.0001" step="any" required value="${Number(l.qty) || 1}"></label><label>Единица<select data-field="unitType"><option value="1" ${l.unitType === 1 ? 'selected' : ''}>${stockEsc(g?.unit || 'Продажи')}</option><option value="2" ${l.unitType === 2 ? 'selected' : ''}>${stockEsc(g?.service_unit || 'Списания')}</option></select></label><label>Цена<input data-field="costPerUnit" type="number" min="0" step="0.01" value="${Number(l.costPerUnit) || 0}" required></label><label>Скидка, %<input data-field="discount" type="number" min="0" max="100" step="any" value="${Number(l.discount) || 0}"></label><button type="button" onclick="stockRemoveLine('${prefix}',${i})">Убрать</button></div>`;
      })
      .join('')
  );
}
function stockReadLines(prefix) {
  return [...stockEl(prefix + 'Lines').querySelectorAll('[data-stock-line]')].map((row) => {
    const v = (k) => row.querySelector('[data-field="' + k + '"]').value;
    return {
      goodRowId: Number(v('good').split(' — ')[0]),
      qty: Number(v('qty')),
      unitType: Number(v('unitType')),
      costPerUnit: Number(v('costPerUnit')),
      discount: Number(v('discount')),
    };
  });
}
function stockLineState(prefix) {
  return prefix === 'stockSale' ? _stockSale : _stockDoc;
}
function stockRenderLines(prefix) {
  const s = stockLineState(prefix);
  stockEl(prefix + 'Lines').innerHTML = stockLinesHtml(prefix, s.lines, s.goods);
  stockUpdateTotal(prefix);
}
function stockUpdateTotal(prefix) {
  const el = stockEl(prefix + 'Total');
  if (el) el.textContent = 'Итого: ' + stockMoney(stockLinesTotal(stockReadLines(prefix)) / 100);
}
function stockAddLine(prefix) {
  const s = stockLineState(prefix);
  s.lines = stockReadLines(prefix);
  s.lines.push({ qty: 1, unitType: 1, costPerUnit: 0, discount: 0 });
  stockRenderLines(prefix);
}
function stockRemoveLine(prefix, i) {
  const s = stockLineState(prefix);
  s.lines = stockReadLines(prefix);
  s.lines.splice(i, 1);
  stockRenderLines(prefix);
}
function stockLineGood(prefix, i, value) {
  const s = stockLineState(prefix);
  s.lines = stockReadLines(prefix);
  const g = s.goods.find((g) => Number(g.id) === Number(value.split(' — ')[0]));
  if (g) {
    s.lines[i].goodRowId = Number(g.id);
    s.lines[i].costPerUnit = Number(g.local_sale_price ?? g.sale_price) || 0;
    s.lines[i].unitType = 1;
  }
  stockRenderLines(prefix);
}
async function stockDocumentOpen(kind) {
  if (_stockDoc.busy) return;
  const req = ++_stockDoc.request;
  try {
    await stockEnsureDictionaries();
    const data = await stockApi('/goods?active=1');
    if (req !== _stockDoc.request) return;
    Object.assign(_stockDoc, { kind, goods: data.goods, lines: [], uncertain: false });
    stockEl('stockDocSave').disabled = false;
    stockEl('stockDocBody').innerHTML = `<h3>${STOCK_KINDS[kind]}</h3><div class="stock-form-row">${stockSelect(
      'stockDocStorage',
      'Склад',
      _stock.dictionaries.storages.filter((s) => s.is_active !== false),
    )}${
      kind === 'move'
        ? stockSelect(
            'stockDocTo',
            'Куда',
            _stock.dictionaries.storages.filter((s) => s.is_active !== false),
          )
        : ''
    }${kind === 'receipt' ? stockSelect('stockDocSupplier', 'Поставщик', _stock.dictionaries.suppliers) : ''}${stockInput('stockDocDate', 'Дата (Москва)', stockLocalTime(), 'datetime-local', 'required')}</div><div id="stockDocLines" oninput="stockUpdateTotal('stockDoc')"></div><button type="button" onclick="stockAddLine('stockDoc')">+ Строка</button><p id="stockDocTotal"></p><label>Комментарий<textarea id="stockDocComment" maxlength="1000"></textarea></label>`;
    stockEl('stockDocSave').hidden = false;
    stockEl('stockDocError').textContent = '';
    stockEl('stockDocModal').showModal();
    stockAddLine('stockDoc');
  } catch (e) {
    stockEl('stockStatus').textContent = e.message;
  }
}
function stockDocFormDraft() {
  return {
    kind: _stockDoc.kind,
    storageId: Number(stockEl('stockDocStorage').value),
    toStorageId: _stockDoc.kind === 'move' ? Number(stockEl('stockDocTo').value) : null,
    supplierId: _stockDoc.kind === 'receipt' ? Number(stockEl('stockDocSupplier').value) || null : null,
    docDate: stockEl('stockDocDate').value + ':00+03:00',
    comment: stockEl('stockDocComment').value,
    lines: stockReadLines('stockDoc'),
  };
}
async function stockSaveDocument(e) {
  e.preventDefault();
  if (_stockDoc.busy || _stockDoc.uncertain) return;
  _stockDoc.busy = true;
  stockEl('stockDocSave').disabled = true;
  try {
    const d = await stockApi('/documents', stockDocFormDraft());
    stockEl('stockDocModal').close();
    await stockRefreshAfterWrite();
    stockEl('stockStatus').textContent = (d.warnings || []).join(' ');
  } catch (e) {
    stockEl('stockDocError').textContent = e.message;
    _stockDoc.uncertain = !!e.uncertain;
  } finally {
    _stockDoc.busy = false;
    stockEl('stockDocSave').disabled = !!_stockDoc.uncertain;
  }
}
stockEl('stockDocModal').addEventListener('cancel', (e) => {
  e.preventDefault();
  stockDocumentClose();
});

function stockSearchGoods(prefix, value) {
  const state = stockLineState(prefix);
  clearTimeout(state.searchTimer);
  const seq = (state.searchSeq || 0) + 1;
  state.searchSeq = seq;
  if (/^\d+ — /.test(value)) return;
  state.searchTimer = setTimeout(async () => {
    try {
      const data = await stockApi('/goods?active=1&search=' + encodeURIComponent(value));
      const list = stockEl(prefix + 'Goods');
      if (state.searchSeq !== seq || !list) return;
      const byId = new Map(state.goods.map((g) => [String(g.id), g]));
      for (const g of data.goods) byId.set(String(g.id), g);
      state.goods = [...byId.values()];
      list.innerHTML = data.goods
        .map((g) => `<option value="${Number(g.id)} — ${stockEsc(g.title)}"></option>`)
        .join('');
    } catch (_) {
      /* Existing choices remain available; a save still validates the good. */
    }
  }, 250);
}
