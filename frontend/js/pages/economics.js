// ── «💰 ЭКОНОМИКА» (только владелец): себестоимость и маржинальность по услугам ──
// Вкладки: services, goods, tech-cards, pay, fixed, equipment, settings. Период —
// пресеты + произвольный диапазон, как на дашборде. Зависимости: api(), esc(),
// notify(), ecoMoney()/ecoPct()/ecoSort()/ecoTotals() из economics-table.js.
const ECO_TABS = ['services', 'goods', 'tech-cards', 'pay', 'fixed', 'equipment', 'settings'];
let _eco = { tab: 'services', from: null, to: null, preset: 'month', report: null, sortKey: 'revenue', sortDir: 'desc', dicts: null, goods: null, cards: null };

function loadEconomics() {
  if (!_eco.from) { const p = ecoPeriodPreset('month', ecoTodayMsk()); _eco.from = p.from; _eco.to = p.to; }
  ecoRenderPeriod();
  ecoSwitchTab(_eco.tab || 'services');
}
function ecoSwitchTab(tab) {
  _eco.tab = tab;
  for (const t of ECO_TABS) {
    const pane = document.getElementById(`ecoTab-${t}`); const btn = document.getElementById(`ecoTabBtn-${t}`);
    if (pane) pane.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  }
  const loaders = { services: ecoLoadServices, goods: ecoLoadGoods, 'tech-cards': ecoLoadTechCards, pay: ecoLoadPay, fixed: ecoLoadFixed, equipment: ecoLoadEquipment, settings: ecoLoadSettings };
  if (typeof loaders[tab] === 'function') loaders[tab]();
}
function ecoRenderPeriod() {
  document.querySelectorAll('#ecoPeriod .pb-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === _eco.preset));
  const f = document.getElementById('ecoFrom'), t = document.getElementById('ecoTo');
  if (f) f.value = _eco.from; if (t) t.value = _eco.to;
  const lbl = document.getElementById('ecoPeriodLabel'); if (lbl) lbl.textContent = `${_eco.from} — ${_eco.to}`;
}
function ecoSetPreset(preset) {
  _eco.preset = preset;
  if (preset !== 'custom') { const p = ecoPeriodPreset(preset, ecoTodayMsk()); _eco.from = p.from; _eco.to = p.to; }
  _eco.report = null; ecoRenderPeriod();
  const r = document.getElementById('ecoRange'); if (r) r.style.display = preset === 'custom' ? '' : 'none';
  if (preset !== 'custom') ecoSwitchTab(_eco.tab);
}
function ecoApplyRange() {
  const f = document.getElementById('ecoFrom').value, t = document.getElementById('ecoTo').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return notify('Укажите обе даты', 'err');
  _eco.from = f <= t ? f : t; _eco.to = f <= t ? t : f; _eco.report = null; ecoRenderPeriod(); ecoSwitchTab(_eco.tab);
}
function ecoQs() { return `from=${_eco.from}&to=${_eco.to}`; }
async function ecoDicts() {
  if (!_eco.dicts) _eco.dicts = await api('GET', '/api/notification-rules/dictionaries');
  return _eco.dicts;
}
function ecoDictName(list, id) { const x = (list || []).find(i => String(i.id) === String(id)); return x ? x.name || x.title : String(id); }

// Загрузчики вкладок — задачи 16–18, 20–21. Заглушки, чтобы каркас работал.
async function ecoLoadServices() {
  const box = document.getElementById('ecoServices'); const sum = document.getElementById('ecoSummary');
  document.getElementById('ecoDetail').innerHTML = '';
  const qs = ecoQs();
  try {
    if (!_eco.report) {
      box.className = ''; box.innerHTML = '<div class="empty">Загрузка…</div>'; sum.innerHTML = '';
      const r = await api('GET', `/api/economics/services?${qs}`);
      if (qs !== ecoQs()) return; // период сменили, пока шёл запрос — ответ устарел
      _eco.report = r;
    }
    box.className = '';
    ecoRenderSummary(_eco.report.summary || {}, sum);
    ecoRenderServices(_eco.report.services || [], box);
  } catch (e) {
    if (qs !== ecoQs()) return;
    box.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; sum.innerHTML = '';
  }
}

function ecoRenderSummary(s, el) {
  el.innerHTML = ecoSummaryTiles(s).map(t =>
    `<div class="sc"><div class="eco-kpi">${esc(t.kpi)}</div><div>${esc(t.title)}</div>${t.sub ? `<div class="eco-kpi-sub">${esc(t.sub)}</div>` : ''}</div>`).join('');
}

function ecoRenderServices(groups, el) {
  if (!groups.length) { el.innerHTML = '<div class="empty">Состоявшихся визитов в периоде нет</div>'; return; }
  const rows = ecoSort(groups, _eco.sortKey, _eco.sortDir);
  const t = ecoTotals(groups);
  const numCls = (c) => (c.fmt === 'text' ? '' : 'num');
  const th = ECO_SERVICE_COLS.map(c => `<th class="${numCls(c)}${_eco.sortKey === c.key ? ' sorted ' + _eco.sortDir : ''}" onclick="ecoSortBy('${c.key}')">${esc(c.title)}</th>`).join('');
  const cell = (g, c) => {
    const v = g[c.key]; const neg = c.fmt === 'money' && typeof v === 'number' && v < 0;
    const txt = c.fmt === 'text'
      ? `${esc(v)}<div class="eco-flags">${ecoFlags(g).map(f => `<span class="badge ${f.cls}" title="${escAttr(f.title)}">${esc(f.text)}</span>`).join('')}</div>`
      : esc(ecoFmt(v, c.fmt));
    return `<td class="${numCls(c)}${neg ? ' eco-neg' : ''}${c.strong ? ' eco-strong' : ''}">${txt}</td>`;
  };
  const body = rows.map(g => `<tr class="eco-row" onclick="ecoOpenService(${Number(g.key)})">${ECO_SERVICE_COLS.map(c => cell(g, c)).join('')}</tr>`).join('');
  const total = `<tr class="eco-total">${ECO_SERVICE_COLS.map(c => {
    const v = t[c.key]; const neg = c.fmt === 'money' && typeof v === 'number' && v < 0;
    return `<td class="${numCls(c)}${neg ? ' eco-neg' : ''}">${c.key === 'label' ? 'Итого' : esc(ecoFmt(v, c.fmt))}</td>`;
  }).join('')}</tr>`;
  el.innerHTML = `<div class="card eco-card-flush"><div class="tw"><table class="eco-tbl eco-tbl-sort"><thead><tr>${th}</tr></thead><tbody>${body}${total}</tbody></table></div></div>
    <div class="eco-kpi-sub" style="margin-top:8px">Материалы — факт списаний YClients по записи; «оценка N» — у N строк списаний не было, взята норма техкарты. Эквайринг без привязанных оплат — по средней доле периода. «Визитов» в итоге — сумма по услугам (визит с двумя услугами считается дважды). Клик по услуге — детализация.</div>`;
}
function ecoSortBy(key) {
  const n = ecoSortNext(_eco, key); _eco.sortKey = n.sortKey; _eco.sortDir = n.sortDir;
  if (_eco.report) ecoRenderServices(_eco.report.services || [], document.getElementById('ecoServices'));
}

async function ecoOpenService(serviceId) {
  const el = document.getElementById('ecoDetail');
  const qs = ecoQs();
  el.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const d = await api('GET', `/api/economics/services/${Number(serviceId)}?${qs}`);
    if (qs !== ecoQs()) return;
    const s = d.service || {};
    const items = ecoDetailLines(s, d.settings).map(l =>
      `<tr class="${l.total ? 'eco-total' : ''}"><td>${esc(l.label)}</td><td class="num">${esc(l.value)}</td><td class="eco-kpi-sub">${esc(l.note)}</td></tr>`).join('');
    const neg = (v) => (typeof v === 'number' && v < 0 ? ' eco-neg' : '');
    const staff = (d.byStaff || []).map(g => `<tr><td>${esc(g.label || '—')}</td><td class="num">${ecoNum(g.visits)}</td><td class="num">${ecoMoney(g.revenue)}</td><td class="num">${ecoMoney(g.materials_used)}</td><td class="num">${ecoMoney(g.doctor_cost)}</td><td class="num${neg(g.contribution)}">${ecoMoney(g.contribution)}</td><td class="num">${ecoPct(g.contribution_pct)}</td></tr>`).join('');
    const visits = (d.visits || []).map(v => `<tr><td>${esc(v.visit_date)}</td><td>${esc(v.staff_name || '—')}</td><td class="num">${ecoMoney(v.price)}</td><td class="num">${ecoMoney(v.bonus_redeemed)}</td><td class="num">${ecoMoney(v.revenue)}</td><td class="num">${ecoMoney(v.materials_used)}</td><td class="num">${ecoMoney(v.doctor_cost)}</td><td class="num">${ecoMoney(v.acquiring_cost)}</td><td class="num${neg(v.contribution)}">${ecoMoney(v.contribution)}</td><td class="num">${ecoNum(v.minutes)}</td><td class="eco-kpi-sub">${esc(ecoVisitFlags(v).join(' · '))}</td></tr>`).join('');
    el.innerHTML = `<div class="card eco-detail">
      <div class="bc-head"><div><div class="bc-head-title">${esc(s.label)}</div><div class="bc-head-sub">${ecoNum(s.visits)} визитов · ${ecoNum(s.hours, 1)} ч</div></div><button class="btn btn-sm" onclick="document.getElementById('ecoDetail').innerHTML=''">✕ Закрыть</button></div>
      <div class="tw"><table class="eco-tbl eco-pl"><tbody>${items}</tbody></table></div>
      <h4 class="eco-h4">По сотрудникам</h4>
      <div class="tw"><table class="eco-tbl"><thead><tr><th>Сотрудник</th><th class="num">Визитов</th><th class="num">Выручка</th><th class="num">Материалы</th><th class="num">Врач</th><th class="num">Марж. прибыль</th><th class="num">%</th></tr></thead><tbody>${staff}</tbody></table></div>
      <h4 class="eco-h4">Визиты</h4>
      <div class="tw"><table class="eco-tbl"><thead><tr><th>Дата</th><th>Сотрудник</th><th class="num">Цена</th><th class="num">Бонусы</th><th class="num">Выручка</th><th class="num">Материалы</th><th class="num">Врач</th><th class="num">Экв.</th><th class="num">Марж.</th><th class="num">Мин</th><th>Флаги</th></tr></thead><tbody>${visits}</tbody></table></div>
    </div>`;
    if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { if (qs === ecoQs()) el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}

// ── Материалы ──
// Шапка с поиском рисуется один раз (иначе перерисовка съедает фокус поля), перерисовывается только тело.
let _ecoGoodsSeq = 0;
async function ecoLoadGoods() {
  const el = document.getElementById('ecoGoods');
  if (!document.getElementById('ecoGoodsBody')) {
    el.className = '';
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">🧴 Материалы</div><div class="bc-head-sub">Цена единицы списания: последняя закупка → ручная → себестоимость YClients</div></div>
        <div class="eco-toolbar"><input id="ecoGoodsSearch" placeholder="Поиск…" onkeydown="if(event.key==='Enter')ecoLoadGoods()"><label class="eco-check"><input type="checkbox" id="ecoGoodsOnly" checked onchange="ecoLoadGoods()"> только расходники</label></div></div>
      <div class="card eco-card-flush"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Товар</th><th>Ед. списания</th><th class="num">Последняя закупка</th><th class="num">Себест. YClients</th><th class="num">Ручная цена</th><th></th></tr></thead><tbody id="ecoGoodsBody"></tbody></table></div></div>`;
  }
  const body = document.getElementById('ecoGoodsBody');
  const q = document.getElementById('ecoGoodsSearch').value;
  const only = document.getElementById('ecoGoodsOnly').checked;
  const seq = ++_ecoGoodsSeq;
  body.innerHTML = '<tr><td colspan="6" class="empty">Загрузка…</td></tr>';
  try {
    const r = await api('GET', `/api/economics/goods?search=${encodeURIComponent(q)}&only_consumables=${only ? 1 : 0}`);
    if (seq !== _ecoGoodsSeq) return; // поиск уже сменился — ответ устарел
    _eco.goods = r.goods || [];
    body.innerHTML = _eco.goods.map(g => {
      const u = ecoGoodsUnit(g);
      return `<tr>
      <td>${esc(g.title)}<div class="eco-kpi-sub">${esc(g.category_title || '')}</div></td>
      <td>${esc(u.main)}${u.sub ? `<div class="eco-kpi-sub">${esc(u.sub)}</div>` : ''}</td>
      <td class="num">${g.last_receipt_price != null ? ecoNum(g.last_receipt_price, 2) : '—'}${g.last_receipt_at ? `<div class="eco-kpi-sub">${esc(String(g.last_receipt_at).slice(0, 10))}</div>` : ''}</td>
      <td class="num">${g.unit_actual_cost != null ? ecoNum(g.unit_actual_cost, 2) : '—'}</td>
      <td class="num"><input type="text" inputmode="decimal" class="eco-price" value="${g.override_price != null ? escAttr(String(g.override_price)) : ''}" placeholder="—" onchange="ecoSavePrice(${Number(g.good_id)}, this)"></td>
      <td><button class="btn btn-sm" onclick="ecoShowReceipts(${Number(g.good_id)}, this)">История</button></td>
    </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">Ничего не найдено</td></tr>';
  } catch (e) { if (seq === _ecoGoodsSeq) body.innerHTML = `<tr><td colspan="6" class="empty">Ошибка: ${esc(e.message)}</td></tr>`; }
}
async function ecoSavePrice(goodId, input) {
  const p = ecoPriceValue(input.value);
  if (p.error) { notify(p.error, 'err'); return ecoLoadGoods(); }
  try {
    await api('PUT', `/api/economics/goods/${Number(goodId)}/price`, { unitPrice: p.value });
    _eco.report = null; notify(p.value === null ? 'Ручная цена снята' : 'Ручная цена сохранена');
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoShowReceipts(goodId, btn) {
  const tr = btn.closest('tr');
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('eco-receipts')) { next.remove(); return; }
  try {
    const r = await api('GET', `/api/economics/goods/${Number(goodId)}/receipts`);
    if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('eco-receipts')) return; // двойной клик
    const rows = (r.receipts || []).map(x => `<tr><td>${esc(String(x.create_date).slice(0, 10))}</td><td class="num">${ecoQty(x.amount)} ${esc(x.unit_title || '')}</td><td class="num">${ecoNum(x.cost_per_unit, 2)}</td><td class="num">${ecoNum(x.discount, 2)}%</td><td class="num">${ecoMoney(x.cost)}</td><td>${esc(x.supplier_title || '')}</td></tr>`).join('');
    tr.insertAdjacentHTML('afterend', `<tr class="eco-receipts"><td colspan="6"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Дата</th><th class="num">Кол-во</th><th class="num">Цена за ед.</th><th class="num">Скидка</th><th class="num">Сумма</th><th>Поставщик</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Поступлений нет</td></tr>'}</tbody></table></div></td></tr>`);
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}

// ── Техкарты и покрытие ──
let _ecoCardsSeq = 0;
async function ecoLoadTechCards() {
  const el = document.getElementById('ecoTechCards');
  const qs = ecoQs(); const seq = ++_ecoCardsSeq;
  try {
    const [cov, cards] = await Promise.all([api('GET', `/api/economics/coverage?${qs}`), api('GET', '/api/economics/tech-cards')]);
    if (seq !== _ecoCardsSeq || qs !== ecoQs()) return;
    el.className = '';
    _eco.cards = cards.cards || [];
    const cardOpts = (sel) => `<option value="">— выбрать техкарту —</option>` + _eco.cards.map(c => `<option value="${Number(c.id)}" ${sel === c.id ? 'selected' : ''}>${esc(c.title)}${c.source === 'manual' ? ' (норма LoyalPro)' : ''}</option>`).join('');
    const rows = (cov.services || []).map(s => {
      const tc = s.tech_card; const sid = Number(s.service_yc_id);
      const sugg = (s.suggestions || []).map(x => `<button class="btn btn-sm" onclick="ecoLinkCard(${sid}, ${Number(x.tech_card_id)})">Похоже: ${esc(x.title)}</button>`).join(' ');
      return `<tr>
        <td>${esc(s.title)}<div class="eco-kpi-sub">${esc(ecoCoverageHint(s))}</div></td>
        <td>${tc ? `<b>${esc(tc.title)}</b> <span class="badge eco-badge-muted">${esc(tc.source)}${tc.staff_yc_id ? ' · сотрудник ' + esc(String(tc.staff_yc_id)) : ''}</span><div class="eco-kpi-sub">${esc(ecoCardItemsText(tc.items))}</div>` : `<span class="badge eco-badge-warn">нет техкарты</span> ${sugg}`}</td>
        <td><div class="eco-actions">
          <select onchange="ecoLinkCard(${sid}, this.value)">${cardOpts(tc ? tc.id : null)}</select>
          <button class="btn btn-sm" data-staff="${escAttr((s.staff_yc_ids || []).join(','))}" onclick="ecoLookupCard(${sid}, this)" title="default_for_staff_and_service по каждому исполнителю (≤4 вызова)">Найти в YClients</button>
          ${tc && tc.source === 'manual' ? `<button class="btn btn-sm" onclick="ecoLinkCard(${sid}, null)">Отвязать</button>` : ''}
        </div></td></tr>`;
    }).join('');
    const manual = _eco.cards.filter(c => c.source === 'manual').map(c => `<tr><td>${esc(c.title)}</td><td class="eco-kpi-sub">${esc(ecoCardItemsText(c.items))}</td><td class="num">${ecoNum(c.links)}</td><td><button class="btn btn-sm" onclick="ecoDeleteManual(${Number(c.id)})">Удалить</button></td></tr>`).join('');
    const open = document.getElementById('ecoManualForm');
    const keepForm = open && open.firstChild ? open : null; // открытую форму переносим узлом — набранные значения сохраняются
    if (keepForm) keepForm.remove();
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">📋 Техкарты и покрытие</div><div class="bc-head-sub">Услуги периода: есть ли норма и доля визитов со списаниями — рабочий список «что заполнить в YClients»</div></div>
        <div class="eco-toolbar"><button class="btn btn-sm" onclick="ecoSyncCards()">⟳ Импорт из YClients</button><button class="btn btn-sm btn-pri" onclick="ecoNewManual()">+ Завести норму</button></div></div>
      <div class="card eco-card-flush"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Услуга</th><th>Техкарта</th><th>Привязка</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">Визитов в периоде нет</td></tr>'}</tbody></table></div></div>
      <div id="ecoManualForm"></div>
      <h4 class="eco-h4">Нормы LoyalPro (ручные)</h4>
      <div class="card eco-card-flush"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Название</th><th>Состав</th><th class="num">Привязок</th><th></th></tr></thead><tbody>${manual || '<tr><td colspan="4" class="empty">Ручных норм нет</td></tr>'}</tbody></table></div></div>
      <div class="eco-kpi-sub" style="margin-top:8px">Импортированных техкарт YClients: ${_eco.cards.filter(c => c.source === 'yclients').length} (только чтение; состав — в YClients).</div>`;
    if (keepForm) document.getElementById('ecoManualForm').replaceWith(keepForm);
  } catch (e) { if (seq === _ecoCardsSeq) el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoLinkCard(serviceId, cardId) {
  try { await api('PUT', `/api/economics/services/${Number(serviceId)}/tech-card`, { techCardId: cardId ? Number(cardId) : null }); _eco.report = null; notify('Привязка сохранена'); ecoLoadTechCards(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); ecoLoadTechCards(); }
}
async function ecoLookupCard(serviceId, btn) {
  const staffIds = String(btn.dataset.staff || '').split(',').filter(Boolean).map(Number);
  if (!staffIds.length) return notify('У услуги в периоде нет исполнителей', 'err');
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/economics/services/${Number(serviceId)}/tech-card/lookup`, { staffYcIds: staffIds });
    _eco.report = null;
    const found = r.found || [];
    notify(found.length ? `Найдено: ${found.map(f => f.title).join(', ')}` : `Проверено исполнителей: ${r.checked}, техкарты в YClients нет`, found.length ? undefined : 'err');
    ecoLoadTechCards();
  } catch (e) { btn.disabled = false; notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoSyncCards() {
  try { const r = await api('POST', '/api/economics/tech-cards/sync'); _eco.report = null; notify(`Импортировано техкарт: ${ecoNum(r.cards)}`); ecoLoadTechCards(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoNewManual() {
  const box = document.getElementById('ecoManualForm');
  box.innerHTML = `<div class="card eco-detail">
    <div class="fg"><label class="fl">Название нормы</label><input id="ecoManTitle" placeholder="Например: Чистка лица — расходники"></div>
    <div id="ecoManItems"></div>
    <button class="btn btn-sm" onclick="ecoManAddItem()">+ Позиция</button>
    <div class="eco-actions" style="margin-top:10px"><button class="btn btn-sm btn-pri" onclick="ecoSaveManual()">Сохранить</button><button class="btn btn-sm" onclick="document.getElementById('ecoManualForm').innerHTML=''">Отмена</button></div></div>`;
  if (!_eco.consGoods) { try { _eco.consGoods = (await api('GET', '/api/economics/goods?only_consumables=1')).goods || []; } catch { _eco.consGoods = []; } }
  ecoManAddItem();
}
function ecoManAddItem() {
  const box = document.getElementById('ecoManItems'); if (!box) return;
  const goods = _eco.consGoods || [];
  const opts = '<option value="">— товар —</option>' + goods.map(g => `<option value="${Number(g.good_id)}" data-unit="${escAttr(ecoGoodsUnit(g).main)}">${esc(g.title)}</option>`).join('');
  box.insertAdjacentHTML('beforeend', `<div class="eco-form eco-man-item">
    <div class="fg"><label class="fl">Товар</label>${goods.length ? `<select class="eco-man-good" onchange="ecoManPickGood(this)">${opts}</select>` : '<input class="eco-man-good" inputmode="numeric" placeholder="id товара YClients">'}</div>
    <div class="fg"><label class="fl">Количество</label><input class="eco-man-amount" inputmode="decimal"></div>
    <div class="fg"><label class="fl">Единица</label><input class="eco-man-unit" placeholder="мл / ед. / шт."></div></div>`);
}
function ecoManPickGood(sel) {
  const u = sel.closest('.eco-man-item').querySelector('.eco-man-unit');
  const opt = sel.options[sel.selectedIndex];
  if (u && !u.value && opt && opt.dataset.unit) u.value = opt.dataset.unit;
}
async function ecoSaveManual() {
  const rows = [...document.querySelectorAll('.eco-man-item')].map(d => ({ goodId: d.querySelector('.eco-man-good').value, amount: d.querySelector('.eco-man-amount').value, unit: d.querySelector('.eco-man-unit').value }));
  const p = ecoParseManualItems(document.getElementById('ecoManTitle').value, rows);
  if (p.error) return notify(p.error, 'err');
  try { await api('POST', '/api/economics/tech-cards', p.value); _eco.report = null; notify('Норма сохранена'); document.getElementById('ecoManualForm').innerHTML = ''; ecoLoadTechCards(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteManual(id) {
  if (!confirm('Удалить норму? Привязки к ней тоже удалятся.')) return;
  try { await api('DELETE', `/api/economics/tech-cards/${Number(id)}`); _eco.report = null; ecoLoadTechCards(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
function ecoLoadPay() {}
function ecoLoadFixed() {}
function ecoLoadEquipment() {}
function ecoLoadSettings() {}
