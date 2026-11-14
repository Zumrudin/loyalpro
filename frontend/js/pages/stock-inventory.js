const _stockInv = {
  doc: null,
  pending: new Map(),
  invalid: new Set(),
  timer: null,
  saving: null,
  posting: false,
  seq: 0,
};
let _stockTurnover = [];
function stockInvRows(lines) {
  return lines.map((l) => ({
    ...l,
    diff:
      l.counted_base == null ? null : Math.round((Number(l.counted_base) - Number(l.expected_base)) * 10000) / 10000,
  }));
}
function stockTurnoverRows(rows, { search = '' } = {}) {
  return rows.filter((r) => String(r.title).toLowerCase().includes(search.toLowerCase()));
}
function stockCsvCell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
async function stockLoadInventory() {
  const el = stockEl('stockTab-inventory');
  el.innerHTML = `<div class="stock-toolbar">${stockSelect(
    'stockInvStorage',
    'Склад',
    _stock.dictionaries.storages.filter((s) => s.is_active !== false),
  )}${stockInput('stockInvCategory', 'Категория (ID или локальное название)', '', 'text')}<button onclick="stockNewInventory()">Новая инвентаризация</button></div><div id="stockInvList"></div><div id="stockInvBody"></div><p id="stockInvStatus" role="status"></p>`;
  try {
    const data = await stockApi('/documents?kind=inventory&limit=200');
    stockEl('stockInvList').innerHTML =
      data.documents
        .map(
          (d) =>
            `<p><button onclick="stockOpenInventory(${Number(d.id)})">№${Number(d.id)} · ${stockDate(d.doc_date)}</button> ${stockDocBadge(d)}${d.status === 'draft' && Date.now() - new Date(d.doc_date) > 7 * 86400000 ? ' · Черновик старше 7 дней' : ''}</p>`,
        )
        .join('') || 'Инвентаризаций нет';
    if (_stockInv.doc) stockRenderInventory();
  } catch (e) {
    el.textContent = e.message;
  }
}
async function stockNewInventory() {
  if (_stockInv.posting) return;
  _stockInv.posting = true;
  try {
    await stockFlushInventory();
    const category = stockEl('stockInvCategory').value.trim();
    const d = await stockApi('/inventories', {
      storageId: Number(stockEl('stockInvStorage').value),
      ...(category
        ? /^\d+$/.test(category)
          ? { categoryPathPrefix: Number(category) }
          : { localCategory: category }
        : {}),
    });
    _stockInv.doc = d;
    stockRenderInventory();
  } catch (e) {
    stockEl('stockInvStatus').textContent = e.message;
  } finally {
    _stockInv.posting = false;
  }
}
async function stockOpenInventory(id) {
  try {
    await stockFlushInventory();
    const seq = ++_stockInv.seq;
    const d = await stockApi('/inventories/' + Number(id));
    if (seq !== _stockInv.seq) return;
    _stockInv.doc = d;
    stockRenderInventory();
  } catch (e) {
    stockEl('stockInvStatus').textContent = e.message;
  }
}
function stockRenderInventory() {
  const d = _stockInv.doc,
    rows = stockInvRows(d.lines);
  stockEl('stockInvBody').innerHTML =
    `<h3>Инвентаризация №${Number(d.id)}</h3><p>Недостач: ${rows.filter((l) => l.diff < 0).length} · Излишков: ${rows.filter((l) => l.diff > 0).length}</p><table class="stock-table"><thead><tr><th>Товар</th><th>Ожидается</th><th>Факт, ед. списания</th><th>Разница</th></tr></thead><tbody>${rows.map((l) => `<tr><td data-label="Товар">${stockEsc(l.title)}</td><td data-label="Ожидается">${Number(l.expected_base)}</td><td data-label="Факт"><input aria-label="${stockEsc(l.title)}" type="number" min="0" step="any" value="${l.counted_base == null ? '' : Number(l.counted_base)}" ${d.status !== 'draft' ? 'disabled' : ''} oninput="stockInventoryChanged(${Number(l.good_row_id)},this.value)"> ${stockEsc(l.service_unit)}</td><td data-label="Разница" id="stockInvDiff-${Number(l.good_row_id)}">${l.diff ?? '—'}</td></tr>`).join('')}</tbody></table>${d.status === 'draft' ? '<button id="stockInvPost" onclick="stockPostInventory()">Провести</button>' : ''}`;
}
function stockInventoryChanged(id, value) {
  if (_stockInv.posting) return;
  if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
    _stockInv.pending.delete(id);
    _stockInv.invalid.add(id);
    stockEl('stockInvStatus').textContent = 'Введите неотрицательный факт; пустое поле не сохранено.';
    return;
  }
  _stockInv.invalid.delete(id);
  const line = { goodRowId: id, counted: Number(value), countedUnitType: 2 };
  _stockInv.pending.set(id, line);
  const row = _stockInv.doc.lines.find((l) => Number(l.good_row_id) === id);
  if (row) row.counted_base = Number(value);
  stockEl('stockInvDiff-' + id).textContent = String(
    Math.round((Number(value) - Number(row?.expected_base || 0)) * 10000) / 10000,
  );
  stockEl('stockInvStatus').textContent = 'Есть несохранённые изменения';
  clearTimeout(_stockInv.timer);
  _stockInv.timer = setTimeout(
    () =>
      stockFlushInventory().catch((e) => {
        stockEl('stockInvStatus').textContent = e.message;
      }),
    800,
  );
}
async function stockFlushInventory() {
  if (_stockInv.invalid.size) throw new Error('Исправьте незаполненный или отрицательный факт перед продолжением.');
  clearTimeout(_stockInv.timer);
  if (_stockInv.saving) await _stockInv.saving;
  if (!_stockInv.pending.size) return;
  const docId = _stockInv.doc.id,
    entries = [..._stockInv.pending];
  _stockInv.pending.clear();
  const run = (async () => {
    try {
      await stockApi('/inventories/' + docId + '/lines', { lines: entries.map(([, v]) => v) }, 'PUT');
      stockEl('stockInvStatus').textContent = _stockInv.pending.size ? 'Есть несохранённые изменения' : 'Сохранено';
    } catch (e) {
      for (const [k, v] of entries) if (!_stockInv.pending.has(k)) _stockInv.pending.set(k, v);
      throw e;
    }
  })();
  _stockInv.saving = run;
  try {
    await run;
  } finally {
    if (_stockInv.saving === run) _stockInv.saving = null;
  }
  if (_stockInv.pending.size) await stockFlushInventory();
}
async function stockPostInventory() {
  if (_stockInv.posting || !confirm('Провести инвентаризацию? Остатки будут скорректированы по заполненным строкам.'))
    return;
  _stockInv.posting = true;
  stockEl('stockInvPost').disabled = true;
  try {
    await stockFlushInventory();
    _stockInv.doc = await stockApi('/inventories/' + _stockInv.doc.id + '/post', {});
    stockRenderInventory();
    stockEl('stockInvStatus').textContent = 'Проведено';
  } catch (e) {
    stockEl('stockInvStatus').textContent = e.message;
    if (stockEl('stockInvPost')) stockEl('stockInvPost').disabled = false;
  } finally {
    _stockInv.posting = false;
  }
}
async function stockLoadTurnover() {
  const el = stockEl('stockTab-turnover');
  if (!stockEl('stockTurnoverRows'))
    el.innerHTML = `<form class="stock-toolbar pb-wrap" onsubmit="event.preventDefault();stockLoadTurnover()">${stockInput('stockTurnoverFrom', 'С', stockToday().slice(0, 8) + '01', 'date', 'required')}${stockInput('stockTurnoverTo', 'По', stockToday(), 'date', 'required')}${stockSelect('stockTurnoverStorage', 'Склад', _stock.dictionaries.storages)}${stockInput('stockTurnoverCategory', 'Категория (ID или название)', '', 'text')}<button>Показать</button><button type="button" onclick="stockExportTurnover()">CSV</button></form><div id="stockTurnoverRows"></div>`;
  try {
    const q = new URLSearchParams({
      from: stockEl('stockTurnoverFrom').value,
      to: stockEl('stockTurnoverTo').value,
      storage: stockEl('stockTurnoverStorage').value,
      category: stockEl('stockTurnoverCategory').value,
    });
    const data = await stockApi('/reports/turnover?' + q);
    _stockTurnover = data.rows;
    stockEl('stockTurnoverRows').innerHTML =
      '<table class="stock-table"><thead><tr><th>Товар / склад</th><th>Начало</th><th>Приход</th><th>Расход</th><th>Конец</th></tr></thead><tbody>' +
      data.rows
        .map(
          (r) =>
            `<tr><td data-label="Товар">${stockEsc(r.title)} / ${stockEsc(r.storage_title)}</td>` +
            [
              ['Начало', 'start_qty'],
              ['Приход', 'inflow'],
              ['Расход', 'outflow'],
              ['Конец', 'end_qty'],
            ]
              .map(
                ([label, k]) =>
                  `<td data-label="${label}">${stockEsc(stockFmtQty(r[k], r.unit_equals, r.unit, r.service_unit))}</td>`,
              )
              .join('') +
            '</tr>',
        )
        .join('') +
      '</tbody></table>';
  } catch (e) {
    stockEl('stockTurnoverRows').textContent = e.message;
  }
}
function stockExportTurnover() {
  const rows = [
    ['Товар', 'Склад', 'Ед. списания', 'Начало', 'Приход', 'Расход', 'Конец'],
    ..._stockTurnover.map((r) => [
      r.title,
      r.storage_title,
      r.service_unit,
      r.start_qty,
      r.inflow,
      r.outflow,
      r.end_qty,
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob(['\ufeff' + rows.map((r) => r.map(stockCsvCell).join(';')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stock-turnover.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
