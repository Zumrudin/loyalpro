const _stockSale = { busy: false, request: 0, goods: [], lines: [], recordId: null, clientId: null, client: null, clientResults: [], requestId: null };
function stockCheckPayments(payments, total, gift) {
  if (gift) {
    if (payments.length) throw new Error('У подарка не бывает оплат.');
    return;
  }
  if (payments.some((p) => !['cash', 'card'].includes(p.method) || !(p.amount > 0)) || payments.reduce((s, p) => s + Math.round(p.amount * 100), 0) !== total)
    throw new Error('Оплаты наличными и картой должны совпадать с итогом.');
}
function stockSaleUuid() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4000-8000-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}
function stockSaleClose() {
  if (!_stockSale.busy) {
    ++_stockSale.request;
    ++_stockSale.clientSearchRequest;
    clearTimeout(_stockSale.clientSearchTimer);
    stockEl('stockSaleModal').close();
  }
}
function stockSaleClientFields(client) {
  const c = client || {};
  const fullName = c.displayName || [c.lastName, c.firstName, c.patronymic].filter(Boolean).join(' ') || _stockSale.clientQuery || '';
  const locked = _stockSale.recordId && _stockSale.clientId ? 'readonly' : '';
  const searchHandler = _stockSale.recordId && _stockSale.clientId ? '' : 'oninput="stockSaleSearchClients(this.value)"';
  return `<div class="stock-sale-client-grid"><label id="stockSaleClientSearchLabel">Клиент<input id="stockSaleClientSearch" type="search" value="${stockEsc(fullName)}" placeholder="Поиск по имени или телефону" autocomplete="off" ${locked} ${searchHandler}></label><div id="stockSaleClientResults" class="stock-sale-client-results" aria-live="polite" hidden></div><label>Фамилия<input id="stockSaleSurname" value="${stockEsc(c.lastName)}" readonly></label><label>Имя<input id="stockSaleName" value="${stockEsc(c.firstName)}" readonly></label><label>Отчество<input id="stockSalePatronymic" value="${stockEsc(c.patronymic)}" readonly></label><label>Телефон<input id="stockSalePhone" value="${stockEsc(c.phone)}" readonly></label><label>Email<input id="stockSaleEmail" type="email" value="${stockEsc(c.email)}" readonly></label></div>`;
}
function stockSaleFormHtml(dict, settings) {
  const [date, time] = stockLocalTime().split('T');
  const [hour, minute] = time.split(':');
  return `<header class="stock-sale-head"><h3>Продажа товара</h3><button id="stockSaleChangeClient" type="button" onclick="stockSaleChangeClient()" hidden>Сменить клиента</button></header><div class="stock-sale-grid"><label>Дата<input id="stockSaleDate" type="date" value="${date}" required></label><label>Часы<input id="stockSaleHour" type="number" min="0" max="23" value="${hour}" required></label><label>Минуты<input id="stockSaleMinute" type="number" min="0" max="59" value="${minute}" required></label></div>${stockSaleClientFields(_stockSale.client)}<div class="stock-sale-meta">${stockSelect('stockSaleStaff', 'Сотрудник', dict.staff, _stockSale.staffYcId)}${stockSelect('stockSaleStorage', 'Склад', dict.storages.filter((s) => s.is_active !== false && s.for_sale !== false), settings.default_sale_storage_id || dict.storages.find((s) => s.for_sale)?.id)}</div><section class="stock-sale-lines"><div id="stockSaleLines" oninput="stockUpdateTotal('stockSale')"></div><div class="stock-sale-add"><button type="button" onclick="stockAddLine('stockSale')">＋ Добавить товар</button><span aria-hidden="true">/</span><button type="button" onclick="stockSaleShowGoods()">Выбрать из списка</button><p id="stockSaleTotal" class="stock-sale-total"></p></div><details id="stockSaleGoodsPicker" class="stock-sale-goods-picker"><summary>Список товаров</summary><label>Поиск товара<input id="stockSaleGoodsSearch" type="search" placeholder="Название или артикул" oninput="stockSaleRenderGoodsList(this.value)"></label><div id="stockSaleGoodsList"></div></details></section><details id="stockSalePaymentOptions" class="stock-sale-payment"><summary>Оплата и подарок</summary><label class="stock-check"><input id="stockSaleGift" type="checkbox" onchange="stockGiftChanged()">Подарок</label><div id="stockSalePayments" class="stock-form-row">${stockInput('stockSaleCash', 'Наличные, ₽', 0, 'number', 'min="0" step="0.01"')}${stockInput('stockSaleCard', 'Карта, ₽', 0, 'number', 'min="0" step="0.01"')}</div></details><details class="stock-sale-comment"><summary>Добавить комментарий</summary><label>Комментарий<textarea id="stockSaleComment" maxlength="1000"></textarea></label></details>`;
}
async function stockSaleOpen(opts = {}) {
  if (_stockSale.busy) return;
  const request = ++_stockSale.request;
  try {
    const [dict, data, settings] = await Promise.all([stockEnsureDictionaries(), stockApi('/goods?active=1'), stockApi('/settings')]);
    if (request !== _stockSale.request) return;
    Object.assign(_stockSale, { uncertain: false, goods: data.goods, lines: [], clientId: opts.clientId || null, client: null, clientQuery: opts.phone || '', recordId: opts.recordId || null, staffYcId: opts.staffYcId || null, requestId: stockSaleUuid(), clientResults: [], clientSearchRequest: (_stockSale.clientSearchRequest || 0) + 1 });
    stockEl('stockSaleBody').innerHTML = stockSaleFormHtml(dict, settings);
    stockEl('stockSaleError').textContent = '';
    stockEl('stockSaleSave').disabled = false;
    stockEl('stockSaleSaveUnpaid').disabled = false;
    stockEl('stockSaleModal').showModal();
    stockAddLine('stockSale');
    if (_stockSale.clientId) await stockSaleLoadClient(_stockSale.clientId, request);
    else if (_stockSale.clientQuery) stockSaleSearchClients(_stockSale.clientQuery);
  } catch (e) {
    stockEl('stockStatus').textContent = e.message;
  }
}
async function stockSaleLoadClient(clientId, request = _stockSale.request) {
  try {
    const client = await stockApi('/clients/' + Number(clientId));
    if (request !== _stockSale.request || Number(clientId) !== Number(_stockSale.clientId)) return;
    _stockSale.client = client;
    stockSaleUpdateClientFields();
  } catch (e) {
    if (request === _stockSale.request) stockEl('stockSaleError').textContent = e.message;
  }
}
function stockSaleUpdateClientFields() {
  const c = _stockSale.client || {};
  stockEl('stockSaleClientSearchLabel').hidden = !!_stockSale.clientId;
  stockEl('stockSaleChangeClient').hidden = !_stockSale.clientId || !!_stockSale.recordId;
  const values = { stockSaleSurname: c.lastName, stockSaleName: c.firstName, stockSalePatronymic: c.patronymic, stockSalePhone: c.phone, stockSaleEmail: c.email };
  for (const [id, value] of Object.entries(values)) if (stockEl(id)) stockEl(id).value = value || '';
  if (stockEl('stockSaleClientSearch')) stockEl('stockSaleClientSearch').value = c.displayName || [c.lastName, c.firstName, c.patronymic].filter(Boolean).join(' ');
  if (stockEl('stockSaleClientResults')) { stockEl('stockSaleClientResults').innerHTML = ''; stockEl('stockSaleClientResults').hidden = true; }
}
function stockSaleChangeClient() {
  if (_stockSale.recordId) return;
  _stockSale.clientId = null;
  _stockSale.client = null;
  stockSaleUpdateClientFields();
  stockEl('stockSaleClientSearch').focus();
}
async function stockSaleSearchClients(query) {
  if (_stockSale.recordId && _stockSale.clientId) return;
  clearTimeout(_stockSale.clientSearchTimer);
  const request = (_stockSale.clientSearchRequest || 0) + 1;
  const modalRequest = _stockSale.request;
  _stockSale.clientSearchRequest = request;
  if (_stockSale.clientId) {
    _stockSale.clientId = null;
    _stockSale.client = null;
    for (const id of ['stockSaleSurname', 'stockSaleName', 'stockSalePatronymic', 'stockSalePhone', 'stockSaleEmail']) if (stockEl(id)) stockEl(id).value = '';
  }
  if (!String(query || '').trim()) { _stockSale.clientResults = []; if (stockEl('stockSaleClientResults')) { stockEl('stockSaleClientResults').innerHTML = ''; stockEl('stockSaleClientResults').hidden = true; } return; }
  _stockSale.clientSearchTimer = setTimeout(async () => {
    try {
      const response = await fetch('/api/clients?' + new URLSearchParams({ search: query, limit: '6' }), { headers: { Authorization: 'Bearer ' + TOKEN }, cache: 'no-store' });
      if (!response.ok) throw new Error('Клиенты недоступны');
      const data = await response.json();
      if (modalRequest !== _stockSale.request || request !== _stockSale.clientSearchRequest) return;
      _stockSale.clientResults = data.clients || [];
      const el = stockEl('stockSaleClientResults');
      if (!el) return;
      el.hidden = false;
      el.innerHTML = _stockSale.clientResults.length ? _stockSale.clientResults.map((c, i) => `<button type="button" data-stock-sale-client="${i}"><strong>${stockEsc(c.name || 'Без имени')}</strong><small>${stockEsc(c.phone || '')}</small></button>`).join('') : '<p>Клиенты не найдены</p>';
      el.querySelectorAll('[data-stock-sale-client]').forEach((button) => { button.onclick = () => stockSaleSelectClient(Number(button.dataset.stockSaleClient)); });
    } catch (_) {
      if (modalRequest === _stockSale.request && request === _stockSale.clientSearchRequest && stockEl('stockSaleClientResults')) { stockEl('stockSaleClientResults').hidden = false; stockEl('stockSaleClientResults').textContent = 'Не удалось найти клиентов.'; }
    }
  }, 250);
}
function stockSaleShowGoods() {
  const picker = stockEl('stockSaleGoodsPicker');
  if (picker) picker.open = true;
  stockSaleRenderGoodsList('');
  const search = stockEl('stockSaleGoodsSearch');
  if (search && typeof search.focus === 'function') search.focus();
}
function stockSaleRenderGoodsList(query) {
  const el = stockEl('stockSaleGoodsList');
  if (!el) return;
  const q = String(query || '').trim().toLowerCase();
  const goods = _stockSale.goods.filter((g) => !q || [g.title, g.article, g.barcode].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 30);
  el.innerHTML = goods.length ? goods.map((g) => `<button type="button" data-stock-sale-good="${Number(g.id)}">${stockEsc(g.title)}${g.article ? ` · ${stockEsc(g.article)}` : ''}</button>`).join('') : '<p>Товары не найдены</p>';
  el.querySelectorAll('[data-stock-sale-good]').forEach((button) => { button.onclick = () => stockSalePickGood(Number(button.dataset.stockSaleGood)); });
}
function stockSalePickGood(goodId) {
  let lines = stockReadLines('stockSale');
  let index = lines.findIndex((line) => !(Number(line.goodRowId) > 0));
  if (index < 0) {
    stockAddLine('stockSale');
    lines = stockReadLines('stockSale');
    index = lines.length - 1;
  }
  const good = _stockSale.goods.find((g) => Number(g.id) === Number(goodId));
  if (!good) return;
  stockLineGood('stockSale', index, `${Number(good.id)} — ${good.title}`);
  if (stockEl('stockSaleGoodsPicker')) stockEl('stockSaleGoodsPicker').open = false;
}
function stockSaleOpenPayment() {
  const section = stockEl('stockSalePaymentOptions');
  if (section) section.open = true;
  const cash = stockEl('stockSaleCash');
  if (cash && typeof cash.focus === 'function') cash.focus();
}
async function stockSaleSelectClient(index) {
  const client = _stockSale.clientResults[index];
  if (!client) return;
  clearTimeout(_stockSale.clientSearchTimer);
  ++_stockSale.clientSearchRequest;
  _stockSale.clientId = Number(client.id);
  _stockSale.client = { id: client.id, displayName: client.name || '', phone: client.phone || '', email: client.email || '' };
  stockSaleUpdateClientFields();
  await stockSaleLoadClient(_stockSale.clientId);
}
function stockGiftChanged() {
  const gift = stockEl('stockSaleGift').checked;
  for (const id of ['stockSaleCash', 'stockSaleCard']) {
    stockEl(id).disabled = gift;
    if (gift) stockEl(id).value = 0;
  }
  if (gift) {
    _stockSale.lines = stockReadLines('stockSale').map((l) => ({ ...l, discount: 100 }));
    stockRenderLines('stockSale');
  }
}
function stockSaleDraft(mode = 'paid') {
  const lines = stockReadLines('stockSale');
  const gift = stockEl('stockSaleGift').checked;
  if (!(Number(_stockSale.clientId) > 0)) throw new Error('Выберите клиента.');
  const payments = [['cash', 'stockSaleCash'], ['card', 'stockSaleCard']].map(([method, id]) => ({ method, amount: Number(stockEl(id).value) })).filter((p) => p.amount !== 0);
  if (mode === 'paid') stockCheckPayments(payments, stockLinesTotal(lines), gift);
  if (mode === 'unpaid' && gift) throw new Error('Подарок нельзя сохранить с долгом.');
  if (gift && stockLinesTotal(lines) !== 0) throw new Error('Для подарка укажите скидку 100% во всех строках.');
  const hour = String(Number(stockEl('stockSaleHour').value)).padStart(2, '0');
  const minute = String(Number(stockEl('stockSaleMinute').value)).padStart(2, '0');
  return { storageId: Number(stockEl('stockSaleStorage').value), clientId: _stockSale.clientId, recordId: _stockSale.recordId, masterStaffYcId: Number(stockEl('stockSaleStaff').value) || null, docDate: `${stockEl('stockSaleDate').value}T${hour}:${minute}:00+03:00`, comment: stockEl('stockSaleComment').value, lines, payments: mode === 'unpaid' ? [] : payments, gift, unpaid: mode === 'unpaid', requestId: _stockSale.requestId };
}
function stockSaleSetButtonsDisabled(disabled) {
  for (const id of ['stockSaleSave', 'stockSaleSaveUnpaid']) if (stockEl(id)) stockEl(id).disabled = disabled;
}
async function stockSaveSale(e, explicitMode) {
  e.preventDefault();
  if (_stockSale.busy || _stockSale.uncertain) return;
  const mode = explicitMode || e.submitter?.dataset?.saleMode || 'paid';
  if (e.submitter && mode === 'paid' && !stockEl('stockSaleGift').checked && !Number(stockEl('stockSaleCash').value) && !Number(stockEl('stockSaleCard').value) && !stockEl('stockSalePaymentOptions').open) {
    stockSaleOpenPayment();
    return;
  }
  _stockSale.busy = true;
  stockSaleSetButtonsDisabled(true);
  try {
    const data = await stockApi('/sales', stockSaleDraft(mode));
    stockEl('stockSaleModal').close();
    await stockRefreshAfterWrite();
    stockEl('stockStatus').textContent = `Продажа №${data.document.id} сохранена.` + (data.document.outstandingAmount > 0 ? ` Долг: ${stockMoney(data.document.outstandingAmount)}.` : '');
    if (typeof jrStockRefresh === 'function') await jrStockRefresh();
  } catch (e) {
    stockEl('stockSaleError').textContent = e.message;
    if (mode === 'paid') stockSaleOpenPayment();
    _stockSale.uncertain = !!e.uncertain;
  } finally {
    _stockSale.busy = false;
    stockSaleSetButtonsDisabled(!!_stockSale.uncertain);
  }
}
stockEl('stockSaleModal').addEventListener('cancel', (e) => { e.preventDefault(); stockSaleClose(); });
