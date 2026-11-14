// Stock panes preserve the appointment DOM and its unsaved service/comment edits.
const jrStockState = { record: null, request: 0, tab: 'services', consumables: null, busy: false };
function jrStockBind(record) {
  jrStockState.record = record;
  jrStockState.request = journal.modalRequest;
  jrStockState.tab = 'services';
  jrStockState.consumables = null;
  const b = jrEl('jrConsumablesOpen');
  if (b) b.onclick = () => jrStockTab('consumables');
}
async function jrStockTab(tab) {
  const r = jrStockState.record;
  if (!r) return;
  jrStockState.tab = tab;
  for (const [key, id] of [
    ['services', 'jrServicesPane'],
    ['goods', 'jrGoodsPane'],
    ['consumables', 'jrConsumablesPane'],
  ]) {
    const el = jrEl(id);
    if (el) el.hidden = key !== tab;
  }
  for (const [key, id] of [
    ['services', 'jrTabServices'],
    ['goods', 'jrTabGoods'],
  ])
    jrEl(id)?.classList?.toggle('is-active', key === tab);
  if (tab !== 'services') await jrStockRefresh();
}
async function jrStockRefresh() {
  const r = jrStockState.record,
    request = jrStockState.request,
    tab = jrStockState.tab;
  if (!r || request !== journal.modalRequest) return;
  const el = jrEl(tab === 'goods' ? 'jrGoodsPane' : 'jrConsumablesPane');
  if (!el || tab === 'services') return;
  el.textContent = 'Загрузка…';
  try {
    if (tab === 'goods') {
      const data = r.id < 0 ? { documents: [] } : await stockApi('/documents?kind=sale&record=' + Number(r.id));
      if (request !== journal.modalRequest || tab !== jrStockState.tab) return;
      el.innerHTML =
        (r.id > 0 && !r.deleted
          ? '<button type="button" onclick="jrStockSell()">Продать товар</button>'
          : '<p>Продажа доступна после отправки записи.</p>') + stockDocsTable(data.documents);
    } else {
      const data = await stockApi('/records/' + Number(r.id) + '/consumables');
      if (request !== journal.modalRequest || tab !== jrStockState.tab) return;
      jrStockState.consumables = data;
      el.innerHTML = jrStockConsumablesHtml(data);
    }
  } catch (e) {
    if (request === journal.modalRequest && tab === jrStockState.tab) el.textContent = e.message;
  }
}
function jrStockSell() {
  const r = jrStockState.record;
  if (r?.id > 0)
    stockSaleOpen({
      recordId: r.id,
      clientId: journal.clientSummary?.clientId,
      phone: r.clientPhone,
      staffYcId: r.staffId,
    });
}
function jrStockConsumablesHtml(data) {
  return (
    `<p>${stockEsc(data.note || '')}</p><p>Материалы визита: факт ${stockMoney(data.summary.actual)} · норма ${stockMoney(data.summary.expected)}</p>` +
    data.services
      .map(
        (s) =>
          `<h4>${stockEsc(s.title)}</h4><table class="stock-table"><thead><tr><th>Товар</th><th>Норма</th><th>Факт</th><th>Разница</th><th>Сумма</th></tr></thead><tbody>${s.rows.map((r) => `<tr><td data-label="Товар">${stockEsc(r.title)}${r.adjustments ? ' · корректировка LoyalPro' : ''}</td><td data-label="Норма">${r.expected} ${stockEsc(r.unit)}</td><td data-label="Факт">${r.actual}</td><td data-label="Разница" class="${r.flag === 'over' ? 'stock-neg' : ''}">${r.diff}</td><td data-label="Сумма">${stockMoney(r.cost)}</td></tr>`).join('')}</tbody></table>${data.recordId > 0 ? `<button type="button" onclick="jrStockEdit(${Number(s.id)})">Изменить состав</button><div id="jrStockEdit-${Number(s.id)}"></div>` : ''}`,
      )
      .join('') +
    (data.unassigned?.length
      ? '<h4>Без привязки к услуге</h4>' +
        data.unassigned
          .map((r) => `<p>${stockEsc(r.title)}: ${r.qtyBase} ${stockEsc(r.unit)} · ${stockMoney(r.cost)}</p>`)
          .join('') +
        '<p>Требуется сверка привязки к услуге.</p>'
      : '')
  );
}
function jrStockEdit(id) {
  const d = jrStockState.consumables,
    s = d.services.find((s) => s.id === id),
    actual = new Map(s.rows.map((r) => [r.goodRowId, r.actual]));
  jrEl('jrStockEdit-' + id).innerHTML =
    `<p>Укажите полный целевой состав в единицах списания. Ноль убирает товар.</p><div class="jr-stock-editor">${d.goods
      .filter((g) => g.stock_active !== false || actual.has(Number(g.id)))
      .map(
        (g) =>
          `<label>${stockEsc(g.title)} (${stockEsc(g.service_unit)})<input type="number" min="0" step="any" data-stock-good="${Number(g.id)}" value="${actual.get(Number(g.id)) || 0}"></label>`,
      )
      .join(
        '',
      )}</div><button type="button" onclick="jrStockSave(${id})">Сохранить расходники</button><p role="alert" id="jrStockError-${id}"></p>`;
}
async function jrStockSave(serviceId) {
  if (jrStockState.busy) return;
  const request = journal.modalRequest,
    r = jrStockState.record;
  const lines = [...jrEl('jrStockEdit-' + serviceId).querySelectorAll('[data-stock-good]')]
    .map((el) => ({ goodRowId: Number(el.dataset.stockGood), qtyBase: Number(el.value) }))
    .filter((l) => l.qtyBase !== 0);
  jrStockState.busy = true;
  try {
    await stockApi('/records/' + Number(r.id) + '/consumables/' + serviceId, { lines }, 'PUT');
    if (request === journal.modalRequest) await jrStockRefresh();
  } catch (e) {
    if (request === journal.modalRequest) jrEl('jrStockError-' + serviceId).textContent = e.message;
  } finally {
    jrStockState.busy = false;
  }
}
