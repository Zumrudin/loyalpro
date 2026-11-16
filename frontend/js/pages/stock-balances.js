function stockFmtQty(qty, equals, unit, baseUnit) {
  const n = Number(qty) || 0,
    eq = Number(equals) || 1,
    abs = Math.abs(n);
  const fmt = (x) => Number(x.toFixed(4)).toLocaleString('ru-RU', { maximumFractionDigits: 4 });
  const sign = n < 0 ? '−' : '';
  if (eq <= 1 || unit === baseUnit) return sign + fmt(abs) + ' ' + (baseUnit || unit || 'ед.');
  const packs = Math.floor(n / eq),
    rest = Number((n - packs * eq).toFixed(4));
  return (
    (packs < 0 ? '−' : '') +
    (packs ? fmt(Math.abs(packs)) + ' ' + (unit || 'уп.') + (rest ? ' + ' : '') : '') +
    (rest || !packs ? fmt(rest) + ' ' + (baseUnit || 'ед.') : '')
  );
}
function stockBalanceRows(goods, storages, filters = {}) {
  return goods
    .filter(
      (g) =>
        (!filters.search || [g.title, g.article, g.barcode].some((v) => String(v || '').toLocaleLowerCase('ru').includes(filters.search.toLocaleLowerCase('ru')))) &&
        (!filters.onlyCritical || (g.balances || []).some((b) => b.critical)) &&
        (!filters.onlyNegative || (g.balances || []).some((b) => b.negative)),
    )
    .slice()
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'ru'));
}
function stockBalancesHtml(goods, storages, filters = {}) {
  const columns = storages.filter((s) => !filters.storage || String(s.id) === String(filters.storage));
  const rows = stockBalanceRows(goods, columns, filters);
  if (!rows.length) return '<div class="empty">Товары не найдены</div>';
  return (
    '<table class="stock-table"><thead><tr><th>Товар</th>' +
    columns.map((s) => '<th>' + stockEsc(s.title) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows
      .map(
        (g) =>
          `<tr><td data-label="Товар"><button class="stock-link" ${UIEvents.attrs("click","stock-balances-1",[UIEvents.value(Number(g.id))])}>${stockEsc(g.title)}</button>${g.source==='loyalpro'?'<span class="stock-badge">LoyalPro</span>':''}</td>${columns.map(s=>{const b=(g.balances||[]).find(b=>String(b.storage_id)===String(s.id));return`<td data-label="${stockEsc(s.title)}" class="${b?.negative?'stock-neg':b?.critical?'stock-crit':''}">${b?stockEsc(stockFmtQty(b.qty_base,g.unit_equals,g.unit,g.service_unit)):'—'}</td>`;}).join('')}</tr>`,
      )
      .join('') +
    '</tbody></table>'
  );
}
function stockGoodsCategory(g) {
  return g.local_category || (g.category_path || []).map((c) => c.title).join(' › ') || 'Без категории';
}
function stockCatalogPageRows() {
  const size = _stock.catalogPageSize;
  const totalPages = Math.max(1, Math.ceil(_stock.goods.length / size));
  _stock.catalogPage = Math.min(Math.max(1, _stock.catalogPage), totalPages);
  const from = (_stock.catalogPage - 1) * size;
  return { rows: _stock.goods.slice(from, from + size), totalPages, from };
}
function stockCatalogCategoryTree() {
  const root = { children: new Map(), id: null };
  const add = (parts, id) => {
    let node = root;
    for (const part of parts) {
      const key = String(part.id);
      if (!node.children.has(key)) node.children.set(key, { children: new Map(), id: null, title: part.title });
      node = node.children.get(key);
      if (part.id != null) node.id = String(part.id);
    }
    node.id = String(id);
  };
  for (const path of _stock.dictionaries.categories || []) {
    if (!Array.isArray(path) || !path.length) continue;
    add(path.map((c) => ({ title: String(c.title || 'Без названия'), id: c.id })), path[path.length - 1].id);
  }
  for (const [id, title] of _stock.localCategories) add([{ title: String(title) + ' (локальная)', id }], id);
  const render = (node) =>
    [...node.children.entries()]
      .sort((a, b) => a[1].title.localeCompare(b[1].title, 'ru'))
      .map(([, child]) => {
        const id = child.id;
        const current = id && String(stockEl('stockCategory').value) === String(id) ? ' aria-current="true"' : '';
        const button = id
          ? `<button type="button" class="stock-link" data-stock-category="${stockEsc(id)}"${current}>${stockEsc(child.title)}</button>`
          : `<span>${stockEsc(child.title)}</span>`;
        return `<li>${button}${child.children.size ? `<ul>${render(child)}</ul>` : ''}</li>`;
      })
      .join('');
  return render(root) || '<li>Категорий нет</li>';
}
function stockGoodsHtml(goods) {
  const { rows, totalPages, from } = stockCatalogPageRows();
  const cap = goods.length >= 2000 ? '<p class="stock-catalog-warning">Показаны первые 2000 товаров; уточните поиск.</p>' : '';
  const selected = _stock.selectedGoods;
  const table = rows.length
    ? `<table class="stock-table stock-catalog-table"><thead><tr><th><input type="checkbox" aria-label="Выбрать товары страницы" data-stock-select-page ${rows.length && rows.every((g) => selected.has(Number(g.id))) ? 'checked' : ''}></th><th>Название</th><th>Цена продажи</th><th>Ед. изм.</th><th>Комментарий</th><th></th></tr></thead><tbody>${rows
        .map((g) => {
          const id = Number(g.id);
          const article = g.article ? `<small>${stockEsc(g.article)}</small>` : '';
          const unit = `1 ${g.unit || 'шт.'} = ${Number(g.unit_equals) || 1} ${g.service_unit || g.unit || 'шт.'}`;
          const note = g.local_note ?? g.comment ?? '';
          return `<tr><td data-label="Выбор"><input type="checkbox" data-stock-select-good="${id}" aria-label="Выбрать ${stockEsc(g.title)}" ${selected.has(id) ? 'checked' : ''}></td><td data-label="Название"><button type="button" class="stock-link" data-stock-open-good="${id}">${stockEsc(g.title)}</button>${article}${g.stock_active === false ? ' <span class="stock-badge">Архив</span>' : ''}</td><td data-label="Цена продажи">${stockMoney(g.local_sale_price ?? g.sale_price)}</td><td data-label="Ед. изм.">${stockEsc(unit)}</td><td data-label="Комментарий">${stockEsc(note)}</td><td data-label="Действия"><button type="button" aria-label="Редактировать товар" data-stock-edit-good="${id}">✎</button></td></tr>`;
        })
        .join('')}</tbody></table>`
    : '<div class="empty">Товары не найдены</div>';
  const pager = `<div class="stock-toolbar stock-catalog-pager"><button type="button" data-stock-page="${_stock.catalogPage - 1}" ${_stock.catalogPage <= 1 ? 'disabled' : ''}>Назад</button><span>Страница ${_stock.catalogPage} из ${totalPages}</span><button type="button" data-stock-page="${_stock.catalogPage + 1}" ${_stock.catalogPage >= totalPages ? 'disabled' : ''}>Далее</button></div>`;
  const archiveToggle = stockEl('stockActive').value === '0'
    ? '<button type="button" data-stock-show-active>Показать активные</button>'
    : '<button type="button" data-stock-show-archive>Архив товаров</button>';
  return `<div class="stock-catalog-layout"><aside class="stock-catalog-sidebar"><section><h3>Действия</h3><button type="button" data-stock-quick-manage>Выбрать товары</button><button type="button" data-stock-bulk-archive ${selected.size && !_stock.goodsLoading ? '' : 'disabled'}>Архивировать выбранные</button>${archiveToggle}</section><section><h3>Категории товаров</h3><button type="button" class="stock-link" data-stock-category="">Все категории</button><ul class="stock-category-tree">${stockCatalogCategoryTree()}</ul></section></aside><section class="stock-catalog-results"><div class="stock-catalog-count" role="status">Найдено: ${goods.length}</div>${cap}${table}${pager}</section></div>`;
}
function stockMountCatalogTools() {
  const filters = stockEl('stockFilters');
  filters.hidden = false;
  let pageSize = stockEl('stockPageSize');
  if (!pageSize) {
    const label = document.createElement('label');
    label.textContent = 'На странице ';
    pageSize = document.createElement('select');
    pageSize.id = 'stockPageSize';
    for (const size of [25, 50, 100]) {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = String(size);
      pageSize.append(option);
    }
    label.append(pageSize);
    const tools = stockEl('stockCatalogTools');
    (tools || filters).append(label);
  }
  if (!pageSize.dataset.catalogBound) {
    pageSize.dataset.catalogBound = '1';
    pageSize.addEventListener('change', stockChangeCatalogPageSize);
  }
  pageSize.value = String(_stock.catalogPageSize);
}
function stockUnmountCatalogTools() {
  const tools = stockEl('stockCatalogTools');
  if (tools) tools.hidden = true;
}
function stockRenderGoodsCatalog() {
  const tab = stockEl('stockTab-goods');
  const tools = stockEl('stockCatalogTools');
  if (tools) tools.hidden = _stock.tab !== 'goods';
  if (_stock.tab === 'goods') stockMountCatalogTools();
  tab.innerHTML = `<div id="stockCatalogContent">${stockGoodsHtml(_stock.goods)}</div>`;
}
function stockChangeCatalogPageSize() {
  _stock.catalogPageSize = Number(stockEl('stockPageSize').value) || 25;
  _stock.catalogPage = 1;
  _stock.selectedGoods.clear();
  stockRenderGoodsCatalog();
}
function stockCatalogSetPage(page) {
  _stock.catalogPage = Number(page) || 1;
  _stock.selectedGoods.clear();
  stockRenderGoodsCatalog();
}
function stockCatalogSelectCategory(value) {
  stockEl('stockCategory').value = value;
  _stock.catalogPage = 1;
  _stock.selectedGoods.clear();
  stockLoadGoods();
}
function stockCatalogSetActive(value) {
  stockEl('stockActive').value = value;
  _stock.catalogPage = 1;
  _stock.selectedGoods.clear();
  stockLoadGoods();
}
function stockQuickManage() {
  const first = stockEl('stockCatalogContent').querySelector('[data-stock-select-good]');
  if (first) first.focus();
  else stockEl('stockStatus').textContent = 'Нет товаров для выбора.';
}
function stockExportGoods() {
  if (_stock.goodsLoading) return;
  const rows = [['Название', 'Артикул', 'Цена продажи', 'Единица продажи', 'Единица списания', 'В упаковке', 'Комментарий']];
  for (const g of _stock.goods) rows.push([g.title, g.article, g.local_sale_price ?? g.sale_price, g.unit, g.service_unit, g.unit_equals, g.local_note ?? g.comment ?? '']);
  const blob = new Blob(['\ufeff' + rows.map((r) => r.map(stockCsvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'goods-export.csv';
  link.click();
  URL.revokeObjectURL(link.href);
  stockEl('stockStatus').textContent = 'Экспорт CSV для Excel готов.';
}
async function stockArchiveSelectedGoods() {
  if (_stock.bulkBusy || _stock.goodsLoading || !_stock.selectedGoods.size) return;
  const { rows } = stockCatalogPageRows();
  const ids = rows.filter((g) => g.stock_active !== false && _stock.selectedGoods.has(Number(g.id))).map((g) => Number(g.id));
  if (!ids.length) return;
  if (!window.confirm(`Архивировать выбранные товары (${ids.length})?`)) return;
  _stock.bulkBusy = true;
  stockRefreshSelectionControls();
  let done = 0;
  let message = '';
  try {
    for (const id of ids) {
      await stockApi('/goods/' + id, { stockActive: false }, 'PUT');
      done += 1;
    }
    message = `Архивировано товаров: ${done}.`;
  } catch (e) {
    message = `Архивировано: ${done} из ${ids.length}. ${e.message}`;
  } finally {
    _stock.selectedGoods.clear();
    await stockLoadGoods();
    await stockLoadCounters();
    _stock.bulkBusy = false;
    stockRefreshSelectionControls();
    stockEl('stockStatus').textContent = message;
  }
}
function stockCatalogBindEvents() {
  const tab = stockEl('stockTab-goods');
  if (!tab || tab.dataset.catalogBound) return;
  tab.dataset.catalogBound = '1';
  tab.addEventListener('click', (event) => {
    const el = event.target.closest('[data-stock-open-good],[data-stock-edit-good],[data-stock-page],[data-stock-category],[data-stock-quick-manage],[data-stock-bulk-archive],[data-stock-export],[data-stock-show-archive],[data-stock-show-active]');
    if (!el) return;
    if (el.dataset.stockOpenGood || el.dataset.stockEditGood) stockOpenGood(Number(el.dataset.stockOpenGood || el.dataset.stockEditGood));
    else if (el.dataset.stockPage) stockCatalogSetPage(el.dataset.stockPage);
    else if ('stockCategory' in el.dataset) stockCatalogSelectCategory(el.dataset.stockCategory);
    else if ('stockQuickManage' in el.dataset) stockQuickManage();
    else if ('stockBulkArchive' in el.dataset) stockArchiveSelectedGoods();
    else if ('stockExport' in el.dataset) stockExportGoods();
    else if ('stockShowArchive' in el.dataset) stockCatalogSetActive('0');
    else if ('stockShowActive' in el.dataset) stockCatalogSetActive('1');
  });
  tab.addEventListener('change', (event) => {
    const input = event.target;
    if (input.matches('[data-stock-select-good]')) {
      const id = Number(input.dataset.stockSelectGood);
      if (input.checked) _stock.selectedGoods.add(id); else _stock.selectedGoods.delete(id);
      stockRefreshSelectionControls();
    } else if (input.matches('[data-stock-select-page]')) {
      const { rows } = stockCatalogPageRows();
      for (const g of rows) input.checked ? _stock.selectedGoods.add(Number(g.id)) : _stock.selectedGoods.delete(Number(g.id));
      stockRefreshSelectionControls();
    }
  });
}
function stockRefreshSelectionControls() {
  const content = stockEl('stockCatalogContent');
  if (!content) return;
  const bulk = content.querySelector('[data-stock-bulk-archive]');
  const { rows } = stockCatalogPageRows();
  const selected = rows.filter((g) => _stock.selectedGoods.has(Number(g.id)));
  if (bulk) bulk.disabled = !selected.some((g) => g.stock_active !== false) || _stock.goodsLoading || _stock.bulkBusy;
  const selectPage = content.querySelector('[data-stock-select-page]');
  if (selectPage) {
    selectPage.checked = !!rows.length && selected.length === rows.length;
    selectPage.indeterminate = selected.length > 0 && selected.length < rows.length;
  }
  for (const input of content.querySelectorAll('[data-stock-select-good]')) {
    input.checked = _stock.selectedGoods.has(Number(input.dataset.stockSelectGood));
  }
}
stockCatalogBindEvents();
function stockCloseGood() {
  if (_stock.busy) return;
  ++_stock.cardRequest;
  stockEl('stockGoodModal').close();
}
function stockInput(id, label, value, type = 'text', attrs = '') {
  return `<label>${stockEsc(label)}<input id="${id}" type="${type}" value="${stockEsc(value ?? '')}" ${attrs}></label>`;
}
function stockUnitOptions(selected) {
  return (
    '<option value="">Выберите единицу</option>' +
    _stock.dictionaries.units
      .map(
        (u) =>
          `<option value="${Number(u.id)}" ${String(selected) === String(u.id) ? 'selected' : ''}>${stockEsc(u.short_title || u.title)}</option>`,
      )
      .join('')
  );
}
function stockGoodFields(g = {}) {
  const local = g.source !== 'yclients';
  return (
    (local
      ? stockInput('stockGoodTitle', 'Название', g.title, 'text', 'required maxlength="500"') +
        stockInput('stockGoodCategory', 'Категория', g.local_category, 'text', 'maxlength="200"') +
        `<div class="stock-form-row"><label>Единица продажи<select id="stockGoodUnit" required>${stockUnitOptions(g.unit_id)}</select></label><label>Единица списания<select id="stockGoodServiceUnit">${stockUnitOptions(g.service_unit_id)}</select></label>${stockInput('stockGoodRatio', 'В упаковке', g.unit_equals ?? 1, 'number', 'min="1" step="any" required')}</div>`
      : '<p>' + stockEsc(g.title) + ' · YClients</p>') +
    '<div class="stock-form-row">' +
    stockInput('stockGoodPrice', 'Цена продажи, ₽', g.local_sale_price, 'number', 'min="0" step="0.01"') +
    (local
      ? stockInput('stockGoodCost', 'Себестоимость упаковки, ₽', g.actual_cost, 'number', 'min="0" step="0.01"') +
        stockInput(
          'stockGoodCritical',
          'Критический остаток, упаковок',
          g.critical_amount,
          'number',
          'min="0" step="any"',
        )
      : '') +
    '</div>' +
    (local ? stockInput('stockGoodBarcode', 'Штрихкод', g.barcode, 'text', 'maxlength="64"') : '') +
    `<label>Заметка<textarea id="stockGoodNote" maxlength="1000">${stockEsc(g.local_note)}</textarea></label><label class="stock-check"><input type="checkbox" id="stockGoodActive" ${g.stock_active === false ? '' : 'checked'}> Активен</label>`
  );
}
function stockGoodFormDraft() {
  const val = (id) => stockEl(id).value,
    num = (id) => (val(id) === '' ? null : Number(val(id)));
  const body = {
    salePrice: num('stockGoodPrice'),
    note: val('stockGoodNote') || null,
    stockActive: stockEl('stockGoodActive').checked,
  };
  if (_stock.good?.source !== 'yclients')
    Object.assign(body, {
      title: val('stockGoodTitle').trim(),
      localCategory: val('stockGoodCategory') || null,
      unitId: num('stockGoodUnit'),
      serviceUnitId: num('stockGoodServiceUnit'),
      unitEquals: num('stockGoodRatio'),
      actualCost: num('stockGoodCost'),
      criticalAmount: num('stockGoodCritical'),
      barcode: val('stockGoodBarcode') || null,
    });
  return body;
}
function stockNewGood() {
  if (_stock.busy) return;
  ++_stock.cardRequest;
  _stock.good = null;
  stockEl('stockGoodTitleText').textContent = 'Новый товар';
  stockEl('stockGoodFields').innerHTML = stockGoodFields();
  stockEl('stockGoodDetails').innerHTML = '';
  stockEl('stockGoodError').textContent = '';
  stockEl('stockGoodModal').showModal();
}
async function stockOpenGood(id) {
  if (_stock.busy) return;
  const request = ++_stock.cardRequest;
  try {
    const card = await stockApi('/goods/' + Number(id));
    if (request !== _stock.cardRequest) return;
    _stock.good = card.good;
    stockEl('stockGoodTitleText').textContent = card.good.title;
    stockEl('stockGoodFields').innerHTML = stockGoodFields(card.good);
    stockEl('stockGoodError').textContent = '';
    stockEl('stockGoodDetails').innerHTML = stockGoodDetailsHtml(card);
    stockEl('stockGoodModal').showModal();
  } catch (e) {
    if (request === _stock.cardRequest) stockEl('stockStatus').textContent = e.message;
  }
}
function stockGoodDetailsHtml(card) {
  const g = card.good,
    qty = (n) => stockEsc(stockFmtQty(n, g.unit_equals, g.unit, g.service_unit));
  return (
    (card.unitPrice ? '<p>Себестоимость единицы списания: ' + stockMoney(card.unitPrice.price) + '</p>' : '') +
    '<h3>Остатки</h3>' +
    card.balances.map((b) => `<p>${stockEsc(b.storage_title)}: ${qty(b.qty_base)}</p>`).join('') +
    '<h3>YClients на снимке</h3>' +
    card.openings
      .map((b) => `<p>${stockEsc(b.storage_title)}: ${qty(b.yc_qty_base)} · ${stockDate(b.taken_at)}</p>`)
      .join('') +
    '<h3>Приходы</h3>' +
    card.receipts
      .map(
        (r) =>
          `<p>${stockDate(r.occurred_at)} · ${stockEsc(r.storage_title)} · ${qty(r.qty_base)} · ${stockMoney(r.cost)} · ${stockEsc(r.origin)}</p>`,
      )
      .join('') +
    '<h3>Техкарты</h3><p>' +
    card.techCards.map((c) => stockEsc(c.title)).join(', ') +
    '</p><h3>Движения</h3><div id="stockGoodMovements">' +
    stockMovementsHtml(card.movements, g) +
    '</div>'
  );
}
function stockMovementsHtml(data, g) {
  const page = Number(data.page) || 1,
    limit = Number(data.limit) || 50;
  return (
    `<table class="stock-table"><thead><tr><th>Дата</th><th>Операция</th><th>Количество</th><th>Сумма</th></tr></thead><tbody>${data.movements.map(m=>`<tr><td data-label="Дата">${stockDate(m.occurred_at)}</td><td data-label="Операция">${stockEsc(m.kind)} · ${stockEsc(m.origin)}${m.deleted_at?' · Отменено':''}</td><td data-label="Количество">${stockEsc(stockFmtQty(m.qty_base,g.unit_equals,g.unit,g.service_unit))}</td><td data-label="Сумма">${stockMoney(m.cost)}</td></tr>`).join('')}</tbody></table><div class="stock-toolbar"><button type="button" ${page<=1?'disabled':''} ${UIEvents.attrs("click","stock-balances-2",[UIEvents.value(page-1)])}>Назад</button><span>Страница ${page}</span><button type="button" ${page*limit>=data.total?'disabled':''} ${UIEvents.attrs("click","stock-balances-3",[UIEvents.value(page+1)])}>Далее</button></div>`
  );
}
async function stockGoodMovements(page) {
  const g = _stock.good,
    request = ++_stock.cardRequest;
  if (!g) return;
  try {
    const data = await stockApi('/goods/' + Number(g.id) + '/movements?page=' + page);
    if (request === _stock.cardRequest) stockEl('stockGoodMovements').innerHTML = stockMovementsHtml(data, g);
  } catch (e) {
    if (request === _stock.cardRequest) stockEl('stockGoodError').textContent = e.message;
  }
}
async function stockSaveGood(event) {
  event.preventDefault();
  if (_stock.busy) return;
  _stock.busy = true;
  stockEl('stockGoodSave').disabled = true;
  stockEl('stockGoodError').textContent = '';
  try {
    const id = _stock.good?.id,
      body = stockGoodFormDraft();
    const result = await stockApi('/goods' + (id ? '/' + Number(id) : ''), body, id ? 'PUT' : 'POST');
    stockEl('stockGoodModal').close();
    ++_stock.cardRequest;
    await stockLoadGoods();
    await stockLoadCounters();
    stockEl('stockStatus').textContent = (result.warnings || []).join(' ');
  } catch (e) {
    stockEl('stockGoodError').textContent = e.message;
  } finally {
    _stock.busy = false;
    stockEl('stockGoodSave').disabled = false;
  }
}
stockEl('stockGoodModal').addEventListener('cancel', (event) => {
  event.preventDefault();
  stockCloseGood();
});
