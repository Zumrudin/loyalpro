// Inline stock draft for the appointment card. A card never opens stockSaleOpen.
const jrStockState = {
  record: null,
  request: 0,
  tab: "services",
  consumables: null,
  busy: false,
  goods: null,
  dictionary: null,
  catalog: [],
  catalogRequest: 0,
  searchTimer: null,
  search: "",
  category: "",
  storageId: "",
  dirty: false,
  requestId: null,
  paymentIds: {},
};
const jrStockUuid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4000-8000-xxxxxxxxxxxx".replace(/x/g, () =>
        Math.floor(Math.random() * 16).toString(16),
      );
const jrStockCents = (value) => Math.round((Number(value) || 0) * 100) / 100;
const jrStockLineTotal = (line) =>
  jrStockCents(
    (Number(line.qty) || 0) *
      (Number(line.price) || 0) *
      (1 - (Number(line.discount) || 0) / 100),
  );
const jrStockKindLabel = (kind) =>
  ({ good: "Товар", certificate: "Сертификат", abonement: "Абонемент" })[
    kind
  ] || "Товар";
function jrStockBind(record) {
  Object.assign(jrStockState, {
    record,
    request: journal.modalRequest,
    tab: "services",
    consumables: null,
    catalog: [],
    search: "",
    category: "",
    storageId: "",
    dirty: false,
    requestId: null,
    paymentIds: {},
    goods: {
      recordId: record.id,
      version: 0,
      lines: [],
      total: 0,
      paid: 0,
      outstanding: 0,
    },
  });
  jrStockState.catalogRequest++;
  clearTimeout(jrStockState.searchTimer);
  const b = jrEl("jrConsumablesOpen");
  if (b) b.onclick = () => jrStockTab("consumables");
  void jrStockLoadGoods();
}
function jrStockCanEdit() {
  return !!jrStockState.record && jrCanChange(jrStockState.record);
}
function jrStockMarkDirty() {
  jrStockState.dirty = true;
  jrStockState.requestId ||= jrStockUuid();
  journal.goodsDirty = true;
  const b = jrEl("jrSaveChanges");
  if (b) b.disabled = false;
}
function jrStockHasDirtyGoods() {
  return !!jrStockState.dirty && jrStockState.request === journal.modalRequest;
}
async function jrStockLoadGoods(opts = {}) {
  const request = jrStockState.request,
    record = jrStockState.record;
  if (!record) return;
  try {
    const [goods, dictionary] = await Promise.all([
      stockApi("/records/" + Number(record.id) + "/goods"),
      stockApi("/dictionaries"),
    ]);
    if (
      request !== journal.modalRequest ||
      record !== jrStockState.record ||
      jrStockState.dirty
    )
      return;
    jrStockState.goods = {
      ...goods,
      lines: Array.isArray(goods.lines) ? goods.lines : [],
    };
    jrStockState.dictionary = dictionary;
    const storage = (dictionary.storages || []).find(
      (s) => s.is_active !== false && s.for_sale !== false,
    );
    if (!(dictionary.storages || []).some(s => String(s.id) === jrStockState.storageId))
      jrStockState.storageId = String(storage?.id || "");
    jrStockRenderLines();
    if (jrStockState.tab === "goods") await jrStockCatalogLoad();
  } catch (e) {
    if (request === journal.modalRequest && jrEl("jrGoodsError"))
      jrEl("jrGoodsError").textContent = e.message;
    if (opts.throwOnError) throw e;
  }
}
async function jrStockTab(tab) {
  if (!jrStockState.record) return;
  jrStockState.tab = tab;
  for (const [key, id] of [
    ["services", "jrServicesPane"],
    ["goods", "jrGoodsPane"],
    ["consumables", "jrConsumablesPane"],
  ]) {
    const el = jrEl(id);
    if (el) el.hidden = key !== tab;
  }
  for (const [key, id] of [
    ["services", "jrTabServices"],
    ["goods", "jrTabGoods"],
  ])
    jrEl(id)?.classList?.toggle("is-active", key === tab);
  if (tab === "goods") await jrStockCatalogLoad();
  if (tab === "consumables") await jrStockRefresh();
}
function jrStockStorageOptions(selected) {
  return (jrStockState.dictionary?.storages || [])
    .filter((s) => s.is_active !== false && s.for_sale !== false)
    .map(
      (s) =>
        `<option value="${Number(s.id)}"${String(s.id) === String(selected) ? " selected" : ""}>${jrEscape(s.title)}</option>`,
    )
    .join("");
}
function jrStockStaffOptions(selected) {
  return `<option value="">Не выбран</option>${(
    jrStockState.dictionary?.staff ||
    journal.data?.staff ||
    []
  )
    .map((s) => {
      const id = s.yclients_id || s.yclientsId || s.id;
      return `<option value="${Number(id)}"${String(id) === String(selected) ? " selected" : ""}>${jrEscape(s.name || s.title)}</option>`;
    })
    .join("")}`;
}
function jrStockRenderLines() {
  const el = jrEl("jrGoodsLines");
  if (!el) return;
  const lines = jrStockState.goods?.lines || [],
    editable = jrStockCanEdit();
  el.innerHTML = lines
    .map((line, index) => {
      const kind = line.kind || "good",
        total = jrStockLineTotal(line),
        code = line.code?.value || "",
        readonly = !!(line.readonly || line.readOnly || line.locked);
      return `<article class="jr-goods-line" data-jr-good-line="${index}"><header class="jr-goods-line-head"><span><strong>${jrEscape(line.title || line.goodTitle || "Товар")}</strong><small>${jrEscape(jrStockKindLabel(kind))}</small></span><button class="jr-goods-line-remove" type="button" data-jr-good-remove="${index}" ${editable && !readonly ? "" : "disabled"} aria-label="Удалить">${jrIcon("trash")}</button></header><div class="jr-goods-line-fields"><label>Кол-во<input data-jr-good-field="qty" data-jr-good-index="${index}" type="number" min="0.001" ${kind === "good" ? 'step="any"' : 'max="1" step="1"'} value="${Number(line.qty) || 1}" ${editable && !readonly ? "" : "disabled"}></label><label>Ед.<input value="${jrEscape(line.unitTypeName || line.unit || "шт")}" readonly></label><label>Цена<input data-jr-good-field="price" data-jr-good-index="${index}" type="number" min="0" step="0.01" value="${Number(line.price) || 0}" ${editable && !readonly ? "" : "disabled"}></label><label>Скидка, %<input data-jr-good-field="discount" data-jr-good-index="${index}" type="number" min="0" max="100" step="0.01" value="${Number(line.discount) || 0}" ${editable && !readonly ? "" : "disabled"}></label><label>Итого<input value="${total.toFixed(2)}" readonly></label><label>Оплачено<input value="${Number(line.paid || 0).toFixed(2)}" readonly></label></div><div class="jr-goods-line-meta"><label>Специалист<select data-jr-good-field="masterStaffYcId" data-jr-good-index="${index}" ${editable && !readonly ? "" : "disabled"}>${jrStockStaffOptions(line.masterStaffYcId)}</select></label><label>Склад<select data-jr-good-field="storageId" data-jr-good-index="${index}" ${editable && !readonly ? "" : "disabled"}>${jrStockStorageOptions(line.storageId)}</select></label></div>${kind === "good" ? "" : `<div class="jr-goods-line-code"><label>Уникальный код<input value="${jrEscape(code)}" readonly placeholder="Код отсутствует"></label><button class="jr-goods-generate-code" type="button" data-jr-good-code="${index}" ${editable && !readonly ? "" : "disabled"}>${code ? "Сгенерировать новый код" : "Сгенерировать код"}</button></div>`}</article>`;
    })
    .join("");
  el.querySelectorAll("[data-jr-good-field]").forEach((n) => {
    n.oninput = jrStockChangeLine;
    n.onchange = jrStockChangeLine;
  });
  el.querySelectorAll("[data-jr-good-remove]").forEach(
    (n) =>
      (n.onclick = () => jrStockRemoveLine(Number(n.dataset.jrGoodRemove))),
  );
  el.querySelectorAll("[data-jr-good-code]").forEach(
    (n) => (n.onclick = () => jrStockReserveCode(Number(n.dataset.jrGoodCode))),
  );
  const total = lines.reduce((s, l) => s + jrStockLineTotal(l), 0),
    paid = Number(jrStockState.goods?.paid || 0),
    summary = jrEl("jrGoodsSummary");
  if (summary)
    summary.textContent = lines.length
      ? `К оплате ${stockMoney(Math.max(0, total - paid))}`
      : "";
  const payment = jrEl("jrGoodsPayment");
  const docs = (jrStockState.goods?.documents || []).filter(
    (document) => Number(document.outstanding) > 0 && !document.locked,
  );
  if (payment) {
    payment.innerHTML = docs
      .map(
        (document) =>
          `<div class="jr-goods-summary"><span>Товары №${Number(document.id)}: <strong>${stockMoney(document.outstanding)}</strong></span><label>Способ <select data-jr-good-pay-method="${Number(document.id)}"><option value="cash">Наличные</option><option value="card">Карта</option></select></label><label>Сумма <input data-jr-good-pay-amount="${Number(document.id)}" type="number" min="0.01" max="${Number(document.outstanding)}" step="0.01" value="${Number(document.outstanding)}"></label><button type="button" data-jr-good-pay="${Number(document.id)}">Оплатить товары</button></div>`,
      )
      .join("");
    payment
      .querySelectorAll("[data-jr-good-pay]")
      .forEach(
        (button) =>
          (button.onclick = () =>
            jrStockPayDocument(Number(button.dataset.jrGoodPay))),
      );
  }
}
async function jrStockPayDocument(documentId) {
  if (jrStockHasDirtyGoods()) {
    if (jrEl("jrGoodsError"))
      jrEl("jrGoodsError").textContent = "Сначала сохраните изменения товаров.";
    return;
  }
  const paymentRoot = jrEl("jrGoodsPayment");
  if (!paymentRoot) return;
  const amount = Number(
    paymentRoot.querySelector(`[data-jr-good-pay-amount="${documentId}"]`)
      ?.value,
  );
  const method = paymentRoot.querySelector(
    `[data-jr-good-pay-method="${documentId}"]`,
  )?.value;
  if (!(amount > 0) || !["cash", "card"].includes(method)) return;
  const request = jrStockState.request;
  const pending = (jrStockState.paymentIds[documentId] ||= {
    paymentId: jrStockUuid(),
    method,
    amount,
    confirmed: false,
  });
  if (pending.method !== method || pending.amount !== amount) {
    if (jrEl("jrGoodsError"))
      jrEl("jrGoodsError").textContent =
        "Оплата уже отправляется с другой суммой. Дождитесь результата.";
    return;
  }
  try {
    await jrWithBusy("Принимаем оплату…", async () => {
      if (!pending.confirmed) {
        await stockApi("/sales/" + documentId + "/payments", {
          paymentId: pending.paymentId,
          method: pending.method,
          amount: pending.amount,
        });
        pending.confirmed = true;
      }
      if (request !== journal.modalRequest) return;
      await jrStockLoadGoods({ throwOnError: true });
      if (request === journal.modalRequest)
        delete jrStockState.paymentIds[documentId];
    });
  } catch (e) {
    if (request === journal.modalRequest && jrEl("jrGoodsError"))
      jrEl("jrGoodsError").textContent = e.message;
  }
}
function jrStockChangeLine(e) {
  const i = Number(e.target.dataset.jrGoodIndex),
    field = e.target.dataset.jrGoodField,
    line = jrStockState.goods?.lines?.[i];
  if (
    !line ||
    !jrStockCanEdit() ||
    line.readonly ||
    line.readOnly ||
    line.locked
  )
    return;
  line[field] = ["qty", "price", "discount"].includes(field)
    ? Number(e.target.value)
    : e.target.value
      ? Number(e.target.value)
      : null;
  if (field === "qty" && line.kind !== "good") line.qty = 1;
  line.total = jrStockLineTotal(line);
  jrStockMarkDirty();
  // Rebuilding this card for each keystroke drops focus and makes decimal
  // amounts impossible to type. The final change redraws derived totals.
  if (e.type !== "input") jrStockRenderLines();
}
function jrStockRemoveLine(i) {
  if (!jrStockCanEdit()) return;
  jrStockState.goods.lines.splice(i, 1);
  jrStockMarkDirty();
  jrStockRenderLines();
}
async function jrStockReserveCode(i) {
  const line = jrStockState.goods?.lines?.[i];
  if (
    !line ||
    !["certificate", "abonement"].includes(line.kind) ||
    !jrStockCanEdit() ||
    line.readonly ||
    line.readOnly ||
    line.locked
  )
    return;
  const request = jrStockState.request;
  try {
    const reservation = await stockApi(
      "/goods/" + Number(line.goodRowId) + "/code-reservations",
      { requestId: jrStockUuid() },
    );
    if (
      request !== journal.modalRequest ||
      line !== jrStockState.goods?.lines?.[i]
    )
      return;
    line.code = {
      id: reservation.id,
      value: reservation.value,
      status: reservation.status,
    };
    line.codeReservationId = reservation.id;
    jrStockMarkDirty();
    jrStockRenderLines();
  } catch (e) {
    if (request === journal.modalRequest && jrEl("jrGoodsError"))
      jrEl("jrGoodsError").textContent = e.message;
  }
}
function jrStockCatalogHtml() {
  const paths = (jrStockState.dictionary?.categories || []).filter(
      Array.isArray,
    ),
    unique = new Map(
      paths.flatMap(p => p.map((c, i) => [String(c.id), { ...c, title: p.slice(0, i + 1).map(n => n.title).join(" › ") }])),
    );
  return `<div class="jr-goods-catalog"><div class="jr-goods-catalog-toolbar"><label>Склад<select id="jrGoodsStorage" ${jrStockCanEdit() ? "" : "disabled"}>${jrStockStorageOptions(jrStockState.storageId)}</select></label><label>Категория<select id="jrGoodsCategory" ${jrStockCanEdit() ? "" : "disabled"}><option value="">Все категории</option>${[...unique.values()].map((c) => `<option value="${Number(c.id)}"${String(c.id) === String(jrStockState.category) ? " selected" : ""}>${jrEscape(c.title)}</option>`).join("")}</select></label><label class="jr-goods-search">Поиск<input id="jrGoodsSearch" type="search" value="${jrEscape(jrStockState.search)}" placeholder="Название, артикул или штрихкод" ${jrStockCanEdit() ? "" : "disabled"}></label></div><div id="jrGoodsCatalog" class="jr-goods-tree" aria-live="polite">Загрузка…</div></div>`;
}
async function jrStockCatalogLoad() {
  if (jrStockState.tab !== "goods") return;
  const pane = jrEl("jrGoodsPane");
  if (!pane) return;
  if (!jrStockState.dictionary) {
    pane.innerHTML = "<p>Загрузка каталога…</p>";
    return;
  }
  pane.innerHTML = jrStockCatalogHtml();
  const storage = jrEl("jrGoodsStorage"),
    category = jrEl("jrGoodsCategory"),
    search = jrEl("jrGoodsSearch");
  if (!storage || !category || !search) return;
  storage.onchange = (e) => {
    jrStockState.storageId = e.target.value;
    clearTimeout(jrStockState.searchTimer);
    void jrStockFetchCatalog();
  };
  category.onchange = (e) => {
    jrStockState.category = e.target.value;
    clearTimeout(jrStockState.searchTimer);
    void jrStockFetchCatalog();
  };
  search.oninput = () => {
    jrStockState.search = search.value;
    jrStockCatalogRequest();
  };
  await jrStockFetchCatalog();
}
function jrStockCatalogRequest() {
  jrStockState.catalogRequest++; // Invalidate earlier results before the debounce fires.
  clearTimeout(jrStockState.searchTimer);
  jrStockState.searchTimer = setTimeout(() => void jrStockFetchCatalog(), 180);
}
async function jrStockFetchCatalog() {
  const request = ++jrStockState.catalogRequest,
    modalRequest = jrStockState.request,
    out = jrEl("jrGoodsCatalog");
  if (!out) return;
  out.textContent = "Загрузка…";
  const q = new URLSearchParams({ active: "1" });
  if (jrStockState.storageId) q.set("storage", jrStockState.storageId);
  if (jrStockState.category) q.set("category", jrStockState.category);
  const search = jrStockState.search.trim();
  if (search) q.set("search", search);
  try {
    const data = await stockApi("/goods?" + q);
    if (
      request !== jrStockState.catalogRequest ||
      modalRequest !== journal.modalRequest ||
      jrStockState.tab !== "goods"
    )
      return;
    jrStockState.catalog = data.goods || [];
    const groups = new Map();
    for (const good of jrStockState.catalog) {
      const path = Array.isArray(good.category_path) ? good.category_path : [];
      const title = path.length
        ? path.map((part) => part.title).join(" › ")
        : "Без категории";
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(good);
    }
    out.innerHTML = jrStockState.catalog.length
      ? [...groups.entries()]
          .map(
            ([title, goods]) =>
              `<details class="jr-goods-category"${search ? " open" : ""}><summary>${jrEscape(title)}</summary><div class="jr-goods-category-content">${goods.map((g) => `<button type="button" class="jr-goods-choice" data-jr-catalog-good="${Number(g.id)}" ${jrStockCanEdit() ? "" : "disabled"}><span>${jrEscape(g.title)}${g.article ? ` · ${jrEscape(g.article)}` : ""}</span><small>${stockMoney(g.local_sale_price ?? g.sale_price)}</small></button>`).join("")}</div></details>`,
          )
          .join("")
      : '<p class="jr-goods-empty">Товары не найдены.</p>';
    out
      .querySelectorAll("[data-jr-catalog-good]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            jrStockAddCatalogGood(Number(b.dataset.jrCatalogGood))),
      );
  } catch (e) {
    if (
      request === jrStockState.catalogRequest &&
      modalRequest === journal.modalRequest
    )
      out.textContent = e.message;
  }
}
function jrStockAddCatalogGood(id) {
  if (!jrStockCanEdit()) return;
  const g = jrStockState.catalog.find((x) => Number(x.id) === Number(id));
  if (!g) return;
  const price = Number(g.local_sale_price ?? g.sale_price) || 0,
    kind =
      g.kind ||
      (g.loyalty_certificate_type_id
        ? "certificate"
        : g.loyalty_abonement_type_id
          ? "abonement"
          : "good");
  jrStockState.goods.lines.push({
    lineId: jrStockUuid(),
    goodRowId: Number(g.id),
    title: g.title,
    storageId: Number(jrStockState.storageId) || null,
    qty: 1,
    unitType: Number(g.unit_id) || 1,
    unitTypeName: g.unit || "шт",
    price,
    discount: 0,
    total: price,
    paid: 0,
    masterStaffYcId: jrStockState.record?.staffId || null,
    kind,
  });
  jrStockMarkDirty();
  jrStockRenderLines();
}
function jrStockPayload() {
  return {
    version: Number(jrStockState.goods?.version || 0),
    requestId: jrStockState.requestId,
    clientId: Number(
      journal.clientSummary?.clientId || jrStockState.record?.clientId,
    ),
    lines: (jrStockState.goods?.lines || [])
      .filter((l) => !l.readonly && !l.readOnly)
      .map((l) => ({
        lineId: l.lineId || undefined,
        goodRowId: Number(l.goodRowId),
        storageId: Number(l.storageId),
        qty: Number(l.qty),
        unitType: l.unitType,
        price: jrStockCents(l.price),
        discount: jrStockCents(l.discount),
        total: jrStockLineTotal(l),
        masterStaffYcId: l.masterStaffYcId ? Number(l.masterStaffYcId) : null,
        ...(l.codeReservationId || l.code?.id
          ? { codeReservationId: l.codeReservationId || l.code.id }
          : {}),
      })),
  };
}
async function jrStockSaveGoods(recordId) {
  if (!jrStockHasDirtyGoods()) return true;
  const saved = await stockApi(
    "/records/" + Number(recordId) + "/goods",
    jrStockPayload(),
    "PUT",
  );
  jrStockState.goods = {
    ...saved,
    lines: Array.isArray(saved.lines) ? saved.lines : [],
  };
  jrStockState.dirty = false;
  journal.goodsDirty = false;
  jrStockState.requestId = jrStockUuid();
  return true;
}
async function jrStockRefresh() {
  const r = jrStockState.record,
    request = jrStockState.request;
  if (
    !r ||
    request !== journal.modalRequest ||
    jrStockState.tab !== "consumables"
  )
    return;
  const el = jrEl("jrConsumablesPane");
  if (!el) return;
  el.textContent = "Загрузка…";
  try {
    const d = await stockApi("/records/" + Number(r.id) + "/consumables");
    if (request !== journal.modalRequest || jrStockState.tab !== "consumables")
      return;
    jrStockState.consumables = d;
    el.innerHTML = jrStockConsumablesHtml(d);
  } catch (e) {
    if (request === journal.modalRequest) el.textContent = e.message;
  }
}
function jrStockConsumablesHtml(d) {
  return (
    `<p>${stockEsc(d.note || "")}</p><p>Материалы визита: факт ${stockMoney(d.summary.actual)} · норма ${stockMoney(d.summary.expected)}</p>` +
    d.services
      .map(
        (s) =>
          `<h4>${stockEsc(s.title)}</h4><table class="stock-table"><thead><tr><th>Товар</th><th>Норма</th><th>Факт</th><th>Разница</th><th>Сумма</th></tr></thead><tbody>${s.rows.map((r) => `<tr><td data-label="Товар">${stockEsc(r.title)}${r.adjustments ? " · корректировка LoyalPro" : ""}</td><td data-label="Норма">${r.expected} ${stockEsc(r.unit)}</td><td data-label="Факт">${r.actual}</td><td data-label="Разница" class="${r.flag === "over" ? "stock-neg" : ""}">${r.diff}</td><td data-label="Сумма">${stockMoney(r.cost)}</td></tr>`).join("")}</tbody></table>${d.recordId > 0 ? `<button type="button" onclick="jrStockEdit(${Number(s.id)})">Изменить состав</button><div id="jrStockEdit-${Number(s.id)}"></div>` : ""}`,
      )
      .join("") +
    (d.unassigned?.length
      ? "<h4>Без привязки к услуге</h4>" +
        d.unassigned
          .map(
            (r) =>
              `<p>${stockEsc(r.title)}: ${r.qtyBase} ${stockEsc(r.unit)} · ${stockMoney(r.cost)}</p>`,
          )
          .join("") +
        "<p>Требуется сверка привязки к услуге.</p>"
      : "")
  );
}
function jrStockEdit(id) {
  const d = jrStockState.consumables,
    s = d.services.find((s) => s.id === id),
    actual = new Map(s.rows.map((r) => [r.goodRowId, r.actual]));
  jrEl("jrStockEdit-" + id).innerHTML =
    `<p>Укажите полный целевой состав в единицах списания. Ноль убирает товар.</p><div class="jr-stock-editor">${d.goods
      .filter((g) => g.stock_active !== false || actual.has(Number(g.id)))
      .map(
        (g) =>
          `<label>${stockEsc(g.title)} (${stockEsc(g.service_unit)})<input type="number" min="0" step="any" data-stock-good="${Number(g.id)}" value="${actual.get(Number(g.id)) || 0}"></label>`,
      )
      .join(
        "",
      )}</div><button type="button" onclick="jrStockSave(${id})">Сохранить расходники</button><p role="alert" id="jrStockError-${id}"></p>`;
}
async function jrStockSave(serviceId) {
  if (jrStockState.busy) return;
  const request = journal.modalRequest,
    r = jrStockState.record,
    lines = [
      ...jrEl("jrStockEdit-" + serviceId).querySelectorAll("[data-stock-good]"),
    ]
      .map((el) => ({
        goodRowId: Number(el.dataset.stockGood),
        qtyBase: Number(el.value),
      }))
      .filter((l) => l.qtyBase !== 0);
  jrStockState.busy = true;
  try {
    await stockApi(
      "/records/" + Number(r.id) + "/consumables/" + serviceId,
      { lines },
      "PUT",
    );
    if (request === journal.modalRequest) await jrStockRefresh();
  } catch (e) {
    if (request === journal.modalRequest)
      jrEl("jrStockError-" + serviceId).textContent = e.message;
  } finally {
    jrStockState.busy = false;
  }
}
