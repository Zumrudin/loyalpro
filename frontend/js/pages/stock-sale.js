const _stockSale = { busy: false, request: 0, goods: [], lines: [], recordId: null, clientId: null };
function stockCheckPayments(payments, total, gift) {
  if (gift) {
    if (payments.length) throw new Error('У подарка не бывает оплат.');
    return;
  }
  if (
    payments.some((p) => !['cash', 'card'].includes(p.method) || !(p.amount > 0)) ||
    payments.reduce((s, p) => s + Math.round(p.amount * 100), 0) !== total
  )
    throw new Error('Оплаты наличными и картой должны совпадать с итогом.');
}
function stockSaleClose() {
  if (!_stockSale.busy) {
    ++_stockSale.request;
    stockEl('stockSaleModal').close();
  }
}
async function stockSaleOpen(opts = {}) {
  if (_stockSale.busy) return;
  const request = ++_stockSale.request;
  try {
    const [dict, data, settings] = await Promise.all([
      stockEnsureDictionaries(),
      stockApi('/goods?active=1'),
      stockApi('/settings'),
    ]);
    if (request !== _stockSale.request) return;
    stockEl('stockSaleSave').disabled = false;
    Object.assign(_stockSale, {
      uncertain: false,
      goods: data.goods,
      lines: [],
      clientId: opts.clientId || null,
      recordId: opts.recordId || null,
    });
    stockEl('stockSaleBody').innerHTML =
      `<h3>Продажа товара</h3>${opts.clientId ? '<p>Пациент выбран из карточки</p>' : stockInput('stockSalePhone', 'Телефон пациента', opts.phone || '', 'tel', 'required autocomplete="off"')}<div class="stock-form-row">${stockSelect(
        'stockSaleStorage',
        'Склад',
        dict.storages.filter((s) => s.is_active !== false),
        settings.default_sale_storage_id || dict.storages.find((s) => s.for_sale)?.id,
      )}${stockSelect('stockSaleStaff', 'Специалист', dict.staff, opts.staffYcId)}</div><div id="stockSaleLines" oninput="stockUpdateTotal('stockSale')"></div><button type="button" onclick="stockAddLine('stockSale')">+ Строка</button><p id="stockSaleTotal"></p><div class="stock-form-row">${stockInput('stockSaleCash', 'Наличные, ₽', 0, 'number', 'min="0" step="0.01"')}${stockInput('stockSaleCard', 'Карта, ₽', 0, 'number', 'min="0" step="0.01"')}</div><label class="stock-check"><input id="stockSaleGift" type="checkbox" onchange="stockGiftChanged()">Подарок</label>`;
    stockEl('stockSaleError').textContent = '';
    stockEl('stockSaleModal').showModal();
    stockAddLine('stockSale');
  } catch (e) {
    stockEl('stockStatus').textContent = e.message;
  }
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
function stockSaleDraft() {
  const lines = stockReadLines('stockSale'),
    gift = stockEl('stockSaleGift').checked;
  const payments = [
    ['cash', 'stockSaleCash'],
    ['card', 'stockSaleCard'],
  ]
    .map(([method, id]) => ({ method, amount: Number(stockEl(id).value) }))
    .filter((p) => p.amount !== 0);
  stockCheckPayments(payments, stockLinesTotal(lines), gift);
  if (gift && stockLinesTotal(lines) !== 0) throw new Error('Для подарка укажите скидку 100% во всех строках.');
  return {
    storageId: Number(stockEl('stockSaleStorage').value),
    clientId: _stockSale.clientId,
    phone: _stockSale.clientId ? undefined : stockEl('stockSalePhone').value,
    recordId: _stockSale.recordId,
    masterStaffYcId: Number(stockEl('stockSaleStaff').value) || null,
    lines,
    payments,
    gift,
  };
}
async function stockSaveSale(e) {
  e.preventDefault();
  if (_stockSale.busy || _stockSale.uncertain) return;
  _stockSale.busy = true;
  stockEl('stockSaleSave').disabled = true;
  try {
    const data = await stockApi('/sales', stockSaleDraft());
    stockEl('stockSaleModal').close();
    await stockRefreshAfterWrite();
    stockEl('stockStatus').textContent =
      `Продажа №${data.document.id} сохранена. ` + (data.document.warnings || []).join(' ');
    if (typeof jrStockRefresh === 'function') await jrStockRefresh();
  } catch (e) {
    stockEl('stockSaleError').textContent = e.message;
    _stockSale.uncertain = !!e.uncertain;
  } finally {
    _stockSale.busy = false;
    stockEl('stockSaleSave').disabled = !!_stockSale.uncertain;
  }
}
stockEl('stockSaleModal').addEventListener('cancel', (e) => {
  e.preventDefault();
  stockSaleClose();
});
