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
// Свой справочник: услуги из management-каталога YClients (все 300+, а не 4
// онлайн-записываемых), сотрудники салона, услуги из записей за 12 мес.
// Неполный ответ (degraded/пусто — YClients не ответил) не кэшируется: следующий
// заход на вкладку спросит снова, а не будет жить с пустыми списками до F5.
async function ecoDicts() {
  if (_eco.dicts) return _eco.dicts;
  const d = await api('GET', '/api/economics/dictionaries');
  if (ecoDictsCacheable(d)) _eco.dicts = d;
  else if (d && d.degraded) notify('Каталог услуг YClients не ответил — список услуг неполный', 'err');
  return d;
}
function ecoDictLabel(i) { return (i.name || i.title || String(i.id)) + (i.is_active === false ? ' (не работает)' : '') + (i.in_catalog === false ? ' (нет в каталоге)' : ''); }
function ecoDictName(list, id) { const x = (list || []).find(i => String(i.id) === String(id)); return x ? x.name || x.title : String(id); }

// Загрузчики вкладок — задачи 16–18, 20–21. Заглушки, чтобы каркас работал.
async function ecoLoadServices() {
  const box = document.getElementById('ecoServices'); const sum = document.getElementById('ecoSummary');
  document.getElementById('ecoDetail').innerHTML = '';
  const qs = ecoQs();
  try {
    if (!_eco.report) {
      box.className = ''; box.innerHTML = '<div class="empty">Загрузка…</div>'; sum.innerHTML = '';
      ecoRenderWarnings([], document.getElementById('ecoWarnings'));
      const r = await api('GET', `/api/economics/services?${qs}`);
      if (qs !== ecoQs()) return; // период сменили, пока шёл запрос — ответ устарел
      _eco.report = r;
    }
    box.className = '';
    ecoRenderSummary(_eco.report.summary || {}, sum);
    ecoRenderWarnings((_eco.report.summary || {}).warnings, document.getElementById('ecoWarnings'));
    ecoRenderServices(_eco.report.services || [], box);
  } catch (e) {
    if (qs !== ecoQs()) return;
    box.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; sum.innerHTML = '';
    ecoRenderWarnings([], document.getElementById('ecoWarnings'));
  }
}

function ecoRenderSummary(s, el) {
  el.innerHTML = ecoSummaryTiles(s).map(t =>
    `<div class="sc"><div class="eco-kpi">${esc(t.kpi)}</div><div>${esc(t.title)}</div>${t.sub ? `<div class="eco-kpi-sub">${esc(t.sub)}</div>` : ''}</div>`).join('');
}

const ECO_WARN_MAX = 30;
const ECO_WARN_ICON = { sync_gap: '🕳️', no_consumables: '📦', overrun: '📈', no_price: '🏷️', price_jump: '💹' };
function ecoRenderWarnings(list, el) {
  if (!el) return;
  const lines = ecoWarningLines(list);
  if (!lines.length) { el.innerHTML = ''; return; }
  const items = lines.slice(0, ECO_WARN_MAX).map(l => `<li><span aria-hidden="true">${ECO_WARN_ICON[l.type] || '•'}</span> ${esc(l.text)}</li>`).join('');
  const more = lines.length > ECO_WARN_MAX ? `<li class="eco-kpi-sub">… и ещё ${lines.length - ECO_WARN_MAX}</li>` : '';
  el.innerHTML = `<div class="card eco-warnings"><div class="eco-warnings-head">⚠️ Предупреждения (${lines.length})</div><ul>${items}${more}</ul>
    <div class="eco-kpi-sub">Только то, что видно в данных: нет техкарты, нормы или сопоставимых приходов — предупреждения нет. Дни, когда в салоне не было ни одного списания, не проверяются (вероятно, данные не загружены).</div></div>`;
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
    const visits = (d.visits || []).map(v => `<tr><td>${esc(v.visit_date)}</td><td>${esc(v.staff_name || '—')}</td><td class="num">${ecoMoney(v.first_cost)}</td><td class="num">${ecoMoney(v.discount)}</td><td class="num">${ecoMoney(v.bonus_applied)}</td><td class="num">${ecoMoney(v.revenue)}</td><td class="num">${ecoMoney(v.materials_used)}</td><td class="num">${ecoMoney(v.doctor_cost)}</td><td class="num">${ecoMoney(v.acquiring_cost)}</td><td class="num${neg(v.contribution)}">${ecoMoney(v.contribution)}</td><td class="num">${ecoNum(v.minutes)}</td><td class="eco-kpi-sub">${esc(ecoVisitFlags(v).join(' · '))}</td></tr>`).join('');
    el.innerHTML = `<div class="card eco-detail">
      <div class="bc-head"><div><div class="bc-head-title">${esc(s.label)}</div><div class="bc-head-sub">${ecoNum(s.visits)} визитов · ${ecoNum(s.hours, 1)} ч</div></div><button class="btn btn-sm" onclick="document.getElementById('ecoDetail').innerHTML=''">✕ Закрыть</button></div>
      <div class="tw"><table class="eco-tbl eco-pl"><tbody>${items}</tbody></table></div>
      <h4 class="eco-h4">По сотрудникам</h4>
      <div class="tw"><table class="eco-tbl"><thead><tr><th>Сотрудник</th><th class="num">Визитов</th><th class="num">Выручка</th><th class="num">Материалы</th><th class="num">Врач</th><th class="num">Марж. прибыль</th><th class="num">%</th></tr></thead><tbody>${staff}</tbody></table></div>
      <h4 class="eco-h4">Визиты</h4>
      <div class="tw"><table class="eco-tbl"><thead><tr><th>Дата</th><th>Сотрудник</th><th class="num">Прайс</th><th class="num">Скидка</th><th class="num">Бонусами</th><th class="num">Выручка</th><th class="num">Материалы</th><th class="num">Врач</th><th class="num">Экв.</th><th class="num">Марж.</th><th class="num">Мин</th><th>Флаги</th></tr></thead><tbody>${visits}</tbody></table></div>
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
      <td class="num">${g.last_receipt_price != null ? ecoNum(g.last_receipt_price, 2) : '—'}${g.last_receipt_at ? `<div class="eco-kpi-sub">${esc(ecoMskDate(g.last_receipt_at))}</div>` : ''}</td>
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
    const rows = (r.receipts || []).map(x => `<tr><td>${esc(ecoMskDate(x.create_date))}</td><td class="num">${ecoQty(x.amount)} ${esc(x.unit_title || '')}</td><td class="num">${ecoNum(x.cost_per_unit, 2)}</td><td class="num">${ecoNum(x.discount, 2)}%</td><td class="num">${ecoMoney(x.cost)}</td><td>${esc(x.supplier_title || '')}</td></tr>`).join('');
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
          <select onchange="if (this.value) ecoLinkCard(${sid}, this.value)">${cardOpts(tc ? tc.id : null)}</select>
          <button class="btn btn-sm" data-staff="${escAttr((s.staff_yc_ids || []).join(','))}" onclick="ecoLookupCard(${sid}, this)" title="default_for_staff_and_service по каждому исполнителю (≤4 вызова)">Найти в YClients</button>
          ${tc && tc.source === 'manual' ? `<button class="btn btn-sm" onclick="ecoUnlinkCard(${sid}, ${tc.staff_yc_id != null ? Number(tc.staff_yc_id) : 'null'})">Отвязать</button>` : ''}
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
  if (!cardId) return; // плейсхолдер «— выбрать техкарту —» ничего не делает; снять — кнопкой «Отвязать»
  try { await api('PUT', `/api/economics/services/${Number(serviceId)}/tech-card`, { techCardId: Number(cardId) }); _eco.report = null; notify('Привязка сохранена'); ecoLoadTechCards(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); ecoLoadTechCards(); }
}
// Снимает только РУЧНУЮ привязку (выученные из списаний/найденные в YClients вернул бы ночной проход).
async function ecoUnlinkCard(serviceId, staffYcId) {
  if (!confirm('Снять ручную привязку техкарты к услуге?')) return;
  const qs = staffYcId ? `?staffYcId=${Number(staffYcId)}` : '';
  try {
    const r = await api('DELETE', `/api/economics/services/${Number(serviceId)}/tech-card${qs}`);
    if (r && r.removed) { _eco.report = null; notify('Ручная привязка снята'); } else notify('Ручной привязки нет — снимать нечего', 'err');
    ecoLoadTechCards();
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
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
// ── Оплата труда: схемы и назначения (спека 2026-10-19-economics-pay-schemes-design.md §5) ──
let _ecoPaySeq = 0;
function ecoSchemeById(id) { return (_eco.schemes || []).find(s => Number(s.id) === Number(id)) || null; }
function ecoPayNames(d) {
  return { staff: new Map((d.staff || []).map(s => [String(s.id), s.name])), services: new Map((d.services || []).map(s => [String(s.id), s.title])), categories: new Map((d.categories || []).map(c => [String(c.id), c.title])) };
}
async function ecoLoadPay() {
  const el = document.getElementById('ecoPay'); const seq = ++_ecoPaySeq;
  try {
    const [r, d, st] = await Promise.all([api('GET', '/api/economics/pay-schemes'), ecoDicts(), api('GET', '/api/economics/settings')]);
    if (seq !== _ecoPaySeq) return;
    el.className = '';
    _eco.schemes = r.schemes || []; _eco.assignments = r.assignments || []; _eco.payDicts = d; _eco.schemeDraft = null;
    _eco.salonMult = Number(st.settings && st.settings.payroll_multiplier) || 1.3;
    const nm = ecoPayNames(d);
    const staffName = (id) => nm.staff.get(String(id)) || `id ${id}`;
    const cards = _eco.schemes.map(s => `<div class="card eco-scheme"><div class="eco-scheme-head"><div><div class="eco-strong">${esc(s.title)}</div><div class="eco-kpi-sub">${s.assigned.length ? 'назначена: ' + esc(s.assigned.map(staffName).join(', ')) : 'никому не назначена'}${s.note ? ' · ' + esc(s.note) : ''}</div></div><div class="eco-actions"><button class="btn btn-sm" onclick="ecoEditScheme(${Number(s.id)})">Изменить</button><button class="btn btn-sm" onclick="ecoDeleteScheme(${Number(s.id)})">Удалить</button></div></div><ul class="eco-lines">${(s.lines || []).map(l => `<li>${esc(ecoLineText(l))}</li>`).join('')}</ul></div>`).join('');
    const aRows = _eco.assignments.map(a => `<tr><td>${esc(staffName(a.staff_yc_id))}</td><td>${esc((ecoSchemeById(a.scheme_id) || {}).title || `схема #${a.scheme_id}`)}</td><td>${esc(a.valid_from || '…')} — ${esc(a.valid_to || '…')}</td><td>${esc(a.note || '')}</td><td><div class="eco-actions"><button class="btn btn-sm" onclick="ecoEditAssignment(${Number(a.id)})">Изменить</button><button class="btn btn-sm" onclick="ecoDeleteAssignment(${Number(a.id)})">Удалить</button></div></td></tr>`).join('');
    const without = ecoStaffWithoutScheme(d.staff, _eco.assignments, ecoTodayMsk());
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">👩‍⚕️ Схемы оплаты</div><div class="bc-head-sub">Схема — линии «категории/услуги → процент». Услуга, названная прямо, важнее категории; категория важнее линии «остальные услуги»</div></div><button class="btn btn-sm btn-pri" onclick="ecoEditScheme(null)">+ Схема</button></div>
      <div id="ecoSchemeForm"></div>
      ${cards || '<div class="card"><div class="empty">Схем нет — создайте схему и назначьте её специалистам, иначе оплата врача в отчёте равна 0</div></div>'}
      <div class="bc-head" style="margin-top:18px"><div><div class="bc-head-title">Назначение специалистам</div><div class="bc-head-sub">Одна схема — любому числу специалистов; периоды одного специалиста не пересекаются</div></div><button class="btn btn-sm btn-pri" onclick="ecoEditAssignment(null)">+ Назначить</button></div>
      <div id="ecoAssignForm"></div>
      <div class="card eco-card-flush"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Сотрудник</th><th>Схема</th><th>Период</th><th>Заметка</th><th></th></tr></thead><tbody>${aRows || '<tr><td colspan="5" class="empty">Назначений нет</td></tr>'}</tbody></table></div></div>
      ${without.length ? `<div class="eco-kpi-sub" style="margin-top:6px">Без схемы на сегодня: ${esc(without.map(s => s.name).join(', '))} — в отчёте у них «нет правила оплаты»</div>` : ''}
      <div class="card" style="margin-top:14px"><div class="bc-head"><div class="bc-head-title">Сверка с YClients</div><div><input type="month" id="ecoPcMonth" value="${escAttr(ecoTodayMsk().slice(0, 7))}"> <button class="btn btn-sm" onclick="ecoPayrollCheck()">Сверить</button></div></div><div id="ecoPcBody" class="eco-kpi-sub">Наш расчёт оплаты по процедурам против итога «Расчёт зарплат» YClients за месяц. Ничего не пересчитывает; по одному запросу в YClients на сотрудника.</div></div>`;
  } catch (e) { if (seq === _ecoPaySeq) el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
let _ecoPcSeq = 0;
async function ecoPayrollCheck() {
  const el = document.getElementById('ecoPcBody'); const seq = ++_ecoPcSeq;
  const month = document.getElementById('ecoPcMonth').value;
  if (!/^\d{4}-\d{2}$/.test(month)) { el.textContent = 'Выберите месяц'; return; }
  el.textContent = 'Считаем… (по запросу на каждого сотрудника)';
  try {
    const r = await api('GET', `/api/economics/payroll-check?month=${encodeURIComponent(month)}`);
    if (seq !== _ecoPcSeq) return;
    const nodata = (t) => `<span class="eco-kpi-sub" title="${escAttr(t || 'YClients не отдал значение')}">нет данных</span>`;
    const body = (r.rows || []).map(x => `<tr><td>${esc(x.staff_name)}${x.no_pay_rule_rows ? `<div class="eco-kpi-sub">без правила оплаты: ${ecoNum(x.no_pay_rule_rows)} стр.</div>` : ''}</td><td class="num">${ecoNum(x.visits)}</td><td class="num">${ecoMoney(x.our_pay)}</td><td class="num">${x.yc_salary === null || x.yc_salary === undefined ? nodata(x.error) : ecoMoney(x.yc_salary)}</td><td class="num ${x.diff < 0 ? 'eco-neg' : ''}">${x.diff === null || x.diff === undefined ? '—' : ecoMoney(x.diff)}</td></tr>`).join('');
    el.innerHTML = `<div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Сотрудник</th><th class="num">Визитов</th><th class="num">Наш расчёт</th><th class="num">YClients</th><th class="num">Разница</th></tr></thead><tbody>${body || '<tr><td colspan="5" class="empty">За месяц нет визитов</td></tr>'}</tbody></table></div>${r.truncated ? '<div class="eco-kpi-sub">Показаны не все сотрудники (кап запросов)</div>' : ''}`;
  } catch (e) { if (seq === _ecoPcSeq) el.textContent = 'Ошибка: ' + e.message; }
}
// Редактор схемы — черновик в _eco.schemeDraft; поля пишут в него по oninput, перерисовка
// целиком только на добавление/удаление линии (иначе теряется фокус), выбор целей
// перерисовывает один пикер.
function ecoNewLine() { return { percent: '30', base: 'gross', mult: '', fixed: '', categories: [], services: [] }; }
function ecoLineFromApi(l) {
  return { percent: String(Number(l.percent)), base: l.base, mult: l.payroll_multiplier === null || l.payroll_multiplier === undefined ? '' : String(Number(l.payroll_multiplier)),
    fixed: Number(l.fixed_per_visit) ? String(Number(l.fixed_per_visit)) : '', categories: (l.categories || []).map(Number), services: (l.services || []).map(Number) };
}
function ecoEditScheme(id) {
  const s = id ? ecoSchemeById(id) : null;
  if (id && !s) return notify('Схема не найдена — обновите вкладку', 'err');
  _eco.schemeDraft = { id: id ? Number(id) : null, title: s ? s.title : '', note: s ? s.note || '' : '', lines: s ? (s.lines || []).map(ecoLineFromApi) : [ecoNewLine()] };
  ecoRenderSchemeForm();
  const t = document.getElementById('ecoSchTitle'); if (t) t.focus();
}
function ecoRenderSchemeForm() {
  const dr = _eco.schemeDraft; const box = document.getElementById('ecoSchemeForm'); if (!dr || !box) return;
  const lines = dr.lines.map((l, i) => `<div class="card eco-line"><div class="eco-line-head"><div class="eco-strong">Линия ${i + 1} <span class="eco-kpi-sub" id="ecoLineKind-${i}">${ecoLineIsFallback(l) ? '· остальные услуги' : ''}</span></div><button class="btn btn-sm" onclick="ecoRemoveLine(${i})">Убрать</button></div>
    <div class="eco-form">
      <div class="fg"><label class="fl">Процент</label><input type="text" inputmode="decimal" value="${escAttr(l.percent)}" oninput="ecoLineField(${i},'percent',this.value)"></div>
      <div class="fg"><label class="fl">База</label><select onchange="ecoLineField(${i},'base',this.value)"><option value="gross" ${l.base !== 'net_of_materials' ? 'selected' : ''}>от выручки</option><option value="net_of_materials" ${l.base === 'net_of_materials' ? 'selected' : ''}>выручка − материалы</option></select></div>
      <div class="fg"><label class="fl">Коэффициент ФОТ</label><input type="text" inputmode="decimal" placeholder="из настроек: ${escAttr(String(_eco.salonMult))}" value="${escAttr(l.mult)}" oninput="ecoLineField(${i},'mult',this.value)"></div>
      <div class="fg"><label class="fl">Фикс за визит, ₽</label><input type="text" inputmode="decimal" value="${escAttr(l.fixed)}" oninput="ecoLineField(${i},'fixed',this.value)"></div>
    </div>
    ${ecoPickerHtml(i, 'categories', 'Категории')}${ecoPickerHtml(i, 'services', 'Услуги')}</div>`).join('');
  box.innerHTML = `<div class="card eco-detail"><div class="eco-form">
    <div class="fg"><label class="fl">Название схемы</label><input id="ecoSchTitle" maxlength="120" value="${escAttr(dr.title)}" oninput="_eco.schemeDraft.title=this.value"></div>
    <div class="fg"><label class="fl">Заметка</label><input maxlength="500" value="${escAttr(dr.note)}" oninput="_eco.schemeDraft.note=this.value"></div></div>
    ${lines}
    <div class="eco-kpi-sub" style="margin-top:8px">Приоритет: услуга, названная в линии прямо, важнее категории; категория важнее линии «остальные услуги» (линия без выбранных категорий и услуг — не больше одной). Одна услуга или категория не может стоять в двух линиях. Пустой коэффициент ФОТ — множитель из настроек.</div>
    <div class="eco-actions" style="margin-top:10px"><button class="btn btn-sm" onclick="ecoAddLine()">+ Линия</button><button class="btn btn-sm btn-pri" id="ecoSchSave" onclick="ecoSaveScheme()">Сохранить</button><button class="btn btn-sm" onclick="ecoCancelScheme()">Отмена</button></div></div>`;
}
function ecoCancelScheme() { _eco.schemeDraft = null; const b = document.getElementById('ecoSchemeForm'); if (b) b.innerHTML = ''; }
function ecoLineField(i, key, value) { const l = _eco.schemeDraft && _eco.schemeDraft.lines[i]; if (l) l[key] = value; }
function ecoAddLine() { if (!_eco.schemeDraft) return; _eco.schemeDraft.lines.push(ecoNewLine()); ecoRenderSchemeForm(); }
function ecoRemoveLine(i) { if (!_eco.schemeDraft) return; _eco.schemeDraft.lines.splice(i, 1); ecoRenderSchemeForm(); }
function ecoPickerList(kind) { const d = _eco.payDicts || {}; return (kind === 'services' ? d.services : d.categories) || []; }
function ecoPickerCatTitle(kind, x) {
  if (kind !== 'services' || x.category_id === null || x.category_id === undefined) return '';
  const c = ((_eco.payDicts || {}).categories || []).find(y => Number(y.id) === Number(x.category_id));
  return c ? ` <span class="eco-kpi-sub">(${esc(c.title)})</span>` : '';
}
function ecoChipsHtml(i, kind) {
  const l = _eco.schemeDraft.lines[i]; const byId = new Map(ecoPickerList(kind).map(x => [Number(x.id), x]));
  return l[kind].map(id => `<span class="eco-chip">${esc(byId.has(id) ? ecoDictLabel(byId.get(id)) : `id ${id}`)}<button type="button" title="Убрать" onclick="ecoPickerToggle(${i},'${kind}',${id})">×</button></span>`).join('') || '<span class="eco-kpi-sub">ничего не выбрано</span>';
}
function ecoPickerListHtml(i, kind, q) {
  const l = _eco.schemeDraft.lines[i]; const chosen = new Set(l[kind].map(Number)); const needle = String(q || '').trim().toLowerCase();
  const items = ecoPickerList(kind).filter(x => !needle || ecoDictLabel(x).toLowerCase().includes(needle));
  if (!items.length) return '<div class="eco-kpi-sub" style="padding:6px">Ничего не найдено</div>';
  return items.map(x => `<label class="eco-pick"><input type="checkbox" ${chosen.has(Number(x.id)) ? 'checked' : ''} onchange="ecoPickerToggle(${i},'${kind}',${Number(x.id)})"> ${esc(ecoDictLabel(x))}${ecoPickerCatTitle(kind, x)}</label>`).join('');
}
function ecoPickerHtml(i, kind, label) {
  return `<div class="eco-picker"><label class="fl">${label}</label><div class="eco-chips" id="ecoChips-${i}-${kind}">${ecoChipsHtml(i, kind)}</div><input type="text" placeholder="Поиск…" id="ecoPkQ-${i}-${kind}" oninput="ecoPickerFilter(${i},'${kind}',this.value)"><div class="eco-picker-list" id="ecoPk-${i}-${kind}">${ecoPickerListHtml(i, kind, '')}</div></div>`;
}
function ecoPickerFilter(i, kind, q) { const el = document.getElementById(`ecoPk-${i}-${kind}`); if (el) el.innerHTML = ecoPickerListHtml(i, kind, q); }
function ecoPickerToggle(i, kind, id) {
  const l = _eco.schemeDraft && _eco.schemeDraft.lines[i]; if (!l) return;
  const n = Number(id);
  l[kind] = l[kind].includes(n) ? l[kind].filter(x => x !== n) : [...l[kind], n];
  const q = document.getElementById(`ecoPkQ-${i}-${kind}`); ecoPickerFilter(i, kind, q ? q.value : '');
  const chips = document.getElementById(`ecoChips-${i}-${kind}`); if (chips) chips.innerHTML = ecoChipsHtml(i, kind);
  const kindEl = document.getElementById(`ecoLineKind-${i}`); if (kindEl) kindEl.textContent = ecoLineIsFallback(l) ? '· остальные услуги' : '';
}
async function ecoSaveScheme() {
  const dr = _eco.schemeDraft; if (!dr) return;
  const p = ecoParseSchemeForm({ title: dr.title, note: dr.note, lines: dr.lines, names: ecoPayNames(_eco.payDicts || {}) });
  if (p.error) return notify(p.error, 'err');
  const btn = document.getElementById('ecoSchSave'); if (btn) btn.disabled = true;
  try {
    await api(dr.id ? 'PUT' : 'POST', dr.id ? `/api/economics/pay-schemes/${dr.id}` : '/api/economics/pay-schemes', p.value);
    _eco.schemeDraft = null; _eco.report = null; notify('Схема сохранена'); ecoLoadPay();
  } catch (e) { if (btn) btn.disabled = false; notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteScheme(id) {
  const s = ecoSchemeById(id);
  if (s && s.assigned && s.assigned.length) return notify('Схема назначена специалистам — сначала снимите назначения', 'err');
  if (!confirm('Удалить схему?')) return;
  try { await api('DELETE', `/api/economics/pay-schemes/${Number(id)}`); _eco.report = null; ecoLoadPay(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
function ecoEditAssignment(id) {
  const d = _eco.payDicts || {};
  const a = id ? (_eco.assignments || []).find(x => Number(x.id) === Number(id)) : { staff_yc_id: '', scheme_id: '', valid_from: '', valid_to: '', note: '' };
  if (!a) return notify('Назначение не найдено — обновите вкладку', 'err');
  const opt = (list, sel, label, text) => `<option value="">${label}</option>` + (sel && !list.some(i => String(i.id) === String(sel)) ? `<option value="${escAttr(String(sel))}" selected>id ${esc(String(sel))} (нет в справочнике)</option>` : '') + list.map(i => `<option value="${escAttr(String(i.id))}" ${String(sel) === String(i.id) ? 'selected' : ''}>${esc(text(i))}</option>`).join('');
  document.getElementById('ecoAssignForm').innerHTML = `<div class="card eco-detail"><div class="eco-form">
    <div class="fg"><label class="fl">Сотрудник</label><select id="ecoAStaff">${opt(d.staff || [], a.staff_yc_id, '— выберите —', ecoDictLabel)}</select></div>
    <div class="fg"><label class="fl">Схема</label><select id="ecoAScheme">${opt(_eco.schemes || [], a.scheme_id, '— выберите —', s => s.title)}</select></div>
    <div class="fg"><label class="fl">Действует с</label><input id="ecoAFrom" type="date" value="${escAttr(a.valid_from || '')}"></div>
    <div class="fg"><label class="fl">по</label><input id="ecoATo" type="date" value="${escAttr(a.valid_to || '')}"></div>
    <div class="fg"><label class="fl">Заметка</label><input id="ecoANote" maxlength="500" value="${escAttr(a.note || '')}"></div></div>
    <div class="eco-kpi-sub" style="margin-top:6px">Период можно не заполнять — схема действует бессрочно.</div>
    <div class="eco-actions" style="margin-top:10px"><button class="btn btn-sm btn-pri" id="ecoASave" onclick="ecoSaveAssignment(${id ? Number(id) : 'null'})">Сохранить</button><button class="btn btn-sm" onclick="document.getElementById('ecoAssignForm').innerHTML=''">Отмена</button></div></div>`;
}
async function ecoSaveAssignment(id) {
  const v = (i) => document.getElementById(i).value;
  const p = ecoParseAssignmentForm({ staff: v('ecoAStaff'), scheme: v('ecoAScheme'), from: v('ecoAFrom'), to: v('ecoATo'), note: v('ecoANote') });
  if (p.error) return notify(p.error, 'err');
  const clash = ecoAssignmentsOverlap(_eco.assignments || [], { id, staff_yc_id: p.value.staffYcId, valid_from: p.value.validFrom, valid_to: p.value.validTo });
  if (clash.length) return notify(`Период пересекается с назначением «${(ecoSchemeById(clash[0].scheme_id) || {}).title || '#' + clash[0].scheme_id}» (${clash[0].valid_from || '…'} — ${clash[0].valid_to || '…'})`, 'err');
  const btn = document.getElementById('ecoASave'); if (btn) btn.disabled = true;
  try {
    await api(id ? 'PUT' : 'POST', id ? `/api/economics/pay-assignments/${Number(id)}` : '/api/economics/pay-assignments', p.value);
    _eco.report = null; notify('Назначение сохранено'); ecoLoadPay();
  } catch (e) { if (btn) btn.disabled = false; notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteAssignment(id) {
  if (!confirm('Снять назначение? Оплата врача за визиты этого периода в отчёте станет 0.')) return;
  try { await api('DELETE', `/api/economics/pay-assignments/${Number(id)}`); _eco.report = null; ecoLoadPay(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}

// ── Настройки ──
let _ecoSetSeq = 0;
async function ecoLoadSettings() {
  const el = document.getElementById('ecoSettings'); const seq = ++_ecoSetSeq;
  try {
    const r = await api('GET', '/api/economics/settings');
    if (seq !== _ecoSetSeq) return;
    el.className = '';
    const s = r.settings || {}; const stored = s.acquiring || {};
    const accounts = (r.accounts || []).map(a => ({ title: a.title, ops: a.operations }));
    // кассы, которые есть в настройках, но в оплатах за 12 месяцев уже не встречаются, не теряем при сохранении
    for (const k of Object.keys(stored)) if (!accounts.some(a => a.title === k)) accounts.push({ title: k, ops: null });
    const acc = accounts.map(a => `<div class="fg"><label class="fl">${esc(a.title)} <span class="eco-kpi-sub">${a.ops === null ? '(нет оплат за 12 мес.)' : `(${ecoNum(a.ops)} оп.)`}</span></label><input class="eco-acq" data-account="${escAttr(a.title)}" type="text" inputmode="decimal" value="${escAttr(String(stored[a.title] ?? 0))}"></div>`).join('');
    const sel = (cond) => (cond ? 'selected' : '');
    el.innerHTML = `<div class="card"><div class="bc-head-title">⚙️ Настройки расчёта</div>
      <div class="eco-form" style="margin-top:12px;align-items:start">
        <div class="fg"><label class="fl">Множитель налогов на ФОТ</label><input id="ecoSMult" type="text" inputmode="decimal" value="${escAttr(String(Number(s.payroll_multiplier)))}"><div class="eco-kpi-sub">1,30 — взносы 30 %. Если процент врача «на руки» — 1,494 (= 1,30 / 0,87)</div></div>
        <div class="fg"><label class="fl">База процента врача</label><select id="ecoSBase"><option value="0" ${sel(!s.pay_base_includes_bonuses)}>выручка (после списания бонусов)</option><option value="1" ${sel(s.pay_base_includes_bonuses)}>стоимость услуг до вычета бонусов (как схемы YClients)</option></select></div>
        <div class="fg"><label class="fl">Драйвер постоянных расходов</label><select id="ecoSDriver"><option value="minutes" ${sel(s.allocation_driver !== 'visits')}>по минутам визита (рекомендуется)</option><option value="visits" ${sel(s.allocation_driver === 'visits')}>поровну на визит</option></select><div class="eco-kpi-sub">По минутам: аренду и администратора потребляет время кабинета. «Поровну» нагружает 15-минутную процедуру как 90-минутную.</div></div>
        <div class="fg"><label class="fl">Ставка УСН, %</label><input id="ecoSUsn" type="text" inputmode="decimal" value="${escAttr(String(Number(s.usn_rate)))}"><div class="eco-kpi-sub">Оценка от положительной операционной прибыли услуги</div></div>
      </div>
      <h4 class="eco-h4">Эквайринг по кассам, %</h4>
      <div class="eco-kpi-sub" style="margin-bottom:8px">Кассы — из оплат за 12 месяцев. С 2026 года комиссия по картам облагается НДС 22 % — закладывайте в процент. Наличные — 0. Допустимо 0–10.</div>
      <div class="eco-form">${acc || '<div class="eco-kpi-sub">Оплат по услугам пока нет</div>'}</div>
      <div class="eco-actions" style="margin-top:14px"><button class="btn btn-pri" id="ecoSSave" onclick="ecoSaveSettings()">Сохранить</button><button class="btn" id="ecoSSync" onclick="ecoRunSync()">⟳ Синхронизировать с YClients сейчас</button></div></div>`;
  } catch (e) { if (seq === _ecoSetSeq) el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoSaveSettings() {
  const acquiring = [...document.querySelectorAll('.eco-acq')].map(i => ({ account: i.dataset.account, value: i.value }));
  const p = ecoParseSettingsForm({ mult: document.getElementById('ecoSMult').value, base: document.getElementById('ecoSBase').value, driver: document.getElementById('ecoSDriver').value, usn: document.getElementById('ecoSUsn').value, acquiring });
  if (p.error) return notify(p.error, 'err');
  const btn = document.getElementById('ecoSSave'); if (btn) btn.disabled = true;
  try { await api('PUT', '/api/economics/settings', p.value); _eco.report = null; notify('Настройки сохранены'); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
  finally { if (btn) btn.disabled = false; }
}
async function ecoRunSync() {
  const btn = document.getElementById('ecoSSync'); if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/economics/sync'); _eco.report = null;
    notify(r.ok ? 'Синхронизация выполнена' : 'Синхронизация с ошибками: ' + Object.keys(r.errors || {}).join(', '), r.ok ? undefined : 'err');
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
  finally { if (btn) btn.disabled = false; }
}

// ── Постоянные расходы ──
let _ecoFixSeq = 0;
async function ecoLoadFixed() {
  const el = document.getElementById('ecoFixed'); const seq = ++_ecoFixSeq;
  try {
    const r = await api('GET', '/api/economics/fixed-costs');
    if (seq !== _ecoFixSeq) return;
    el.className = '';
    _eco.fixed = r.rows || [];
    const blocks = ecoFixedMonths(_eco.fixed, ecoTodayMsk()).map(m => {
      const rows = ecoFixedForMonth(_eco.fixed, m);
      const tr = rows.map(x => `<tr><td>${esc(ECO_FIXED_CATS[x.category] || x.category)}</td><td>${esc(x.title)}${x.note ? `<div class="eco-kpi-sub">${esc(x.note)}</div>` : ''}</td><td class="num">${ecoMoney(x.amount_month)}</td><td>${esc(x.month_from.slice(0, 7))} — ${x.month_to ? esc(x.month_to.slice(0, 7)) : '…'}</td><td><div class="eco-actions"><button class="btn btn-sm" onclick="ecoEditFixed(${Number(x.id)})">Изменить</button><button class="btn btn-sm" onclick="ecoDeleteFixed(${Number(x.id)})">Удалить</button></div></td></tr>`).join('');
      return `<div class="card eco-card-flush" style="margin-bottom:12px"><div class="bc-head" style="padding:12px 16px 0"><div class="bc-head-title">${esc(m)} · ${ecoMoney(ecoFixedTotal(rows))} в месяц</div><button class="btn btn-sm" onclick="ecoCopyFixed('${escAttr(m)}')">Скопировать в ${esc(ecoNextMonth(m))}</button></div>
        <div class="tw"><table class="eco-tbl"><thead><tr><th>Статья</th><th>Название</th><th class="num">В месяц</th><th>Действует</th><th></th></tr></thead><tbody>${tr || '<tr><td colspan="5" class="empty">Статей нет</td></tr>'}</tbody></table></div></div>`;
    }).join('');
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">🏢 Постоянные расходы</div><div class="bc-head-sub">Помесячный бюджет по статьям. В отчёте делится по минутам визитов (или поровну) с учётом доли дней месяца в периоде</div></div><button class="btn btn-sm btn-pri" onclick="ecoEditFixed(null)">+ Статья</button></div><div id="ecoFixedForm"></div>${blocks}`;
  } catch (e) { if (seq === _ecoFixSeq) el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
function ecoEditFixed(id) {
  const x = id ? (_eco.fixed || []).find(f => Number(f.id) === Number(id)) : { category: 'rent', title: '', amount_month: '', month_from: ecoTodayMsk().slice(0, 7) + '-01', month_to: null, note: '' };
  if (!x) return notify('Статья не найдена — обновите вкладку', 'err');
  const cats = Object.entries(ECO_FIXED_CATS).map(([k, v]) => `<option value="${escAttr(k)}" ${x.category === k ? 'selected' : ''}>${esc(v)}</option>`).join('');
  document.getElementById('ecoFixedForm').innerHTML = `<div class="card eco-detail" style="margin-bottom:12px"><div class="eco-form">
    <div class="fg"><label class="fl">Статья</label><select id="ecoFCat">${cats}</select></div>
    <div class="fg"><label class="fl">Название</label><input id="ecoFTitle" maxlength="255" value="${escAttr(x.title)}" placeholder="Аренда, 2 этаж"></div>
    <div class="fg"><label class="fl">Сумма в месяц, ₽</label><input id="ecoFAmount" type="text" inputmode="decimal" value="${escAttr(String(x.amount_month === '' ? '' : Number(x.amount_month)))}"></div>
    <div class="fg"><label class="fl">С месяца</label><input id="ecoFFrom" type="month" value="${escAttr(x.month_from.slice(0, 7))}"></div>
    <div class="fg"><label class="fl">По месяц (пусто — бессрочно)</label><input id="ecoFTo" type="month" value="${escAttr(x.month_to ? x.month_to.slice(0, 7) : '')}"></div>
    <div class="fg"><label class="fl">Заметка</label><input id="ecoFNote" maxlength="500" value="${escAttr(x.note || '')}"></div>
    </div><div class="eco-actions" style="margin-top:10px"><button class="btn btn-sm btn-pri" id="ecoFSave" onclick="ecoSaveFixed(${id ? Number(id) : 'null'})">Сохранить</button><button class="btn btn-sm" onclick="document.getElementById('ecoFixedForm').innerHTML=''">Отмена</button></div></div>`;
}
async function ecoSaveFixed(id) {
  const v = (i) => document.getElementById(i).value;
  const p = ecoParseFixedForm({ category: v('ecoFCat'), title: v('ecoFTitle'), amount: v('ecoFAmount'), from: v('ecoFFrom'), to: v('ecoFTo'), note: v('ecoFNote') });
  if (p.error) return notify(p.error, 'err');
  const btn = document.getElementById('ecoFSave'); if (btn) btn.disabled = true;
  try { await api(id ? 'PUT' : 'POST', id ? `/api/economics/fixed-costs/${Number(id)}` : '/api/economics/fixed-costs', p.value); _eco.report = null; notify('Сохранено'); ecoLoadFixed(); }
  catch (e) { if (btn) btn.disabled = false; notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteFixed(id) {
  if (!confirm('Удалить статью?')) return;
  try { await api('DELETE', `/api/economics/fixed-costs/${Number(id)}`); _eco.report = null; ecoLoadFixed(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoCopyFixed(month) {
  if (!ecoIsMonth(month)) return;
  const next = ecoNextMonth(month);
  try { const r = await api('POST', `/api/economics/fixed-costs/copy?from=${month}&to=${next}`); _eco.report = null; notify(`Скопировано статей: ${ecoNum(r.copied)} → ${next}`); ecoLoadFixed(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}

// ── Аппараты ──
let _ecoEqSeq = 0;
async function ecoLoadEquipment() {
  const el = document.getElementById('ecoEquipment'); const seq = ++_ecoEqSeq;
  try {
    const [r, d] = await Promise.all([api('GET', '/api/economics/equipment'), ecoDicts()]);
    if (seq !== _ecoEqSeq) return;
    el.className = '';
    _eco.equipment = r.rows || [];
    const svcNames = (ids) => (ids || []).length ? (ids || []).map(id => esc(ecoDictName(d.services, id))).join(', ') : '<span class="badge eco-badge-warn">не привязан</span>';
    const rows = _eco.equipment.map(e => `<tr${e.is_active ? '' : ' style="opacity:.5"'}><td>${esc(e.name)}${e.is_active ? '' : ' <span class="badge eco-badge-muted">не активен</span>'}${e.note ? `<div class="eco-kpi-sub">${esc(e.note)}</div>` : ''}</td><td class="num">${ecoMoney(e.purchase_price)}</td><td>${esc(e.purchase_date || '—')}</td><td class="num">${ecoNum(e.useful_life_months)}</td><td class="num">${ecoNum(Number(e.residual_pct), 1)}%</td><td class="num">${ecoMoney(e.maintenance_monthly)}</td><td class="num eco-strong">${ecoMoney(e.monthly && e.monthly.total !== undefined ? e.monthly.total : e.monthly)}</td><td>${svcNames(e.service_ids)}</td><td><div class="eco-actions"><button class="btn btn-sm" onclick="ecoEditEq(${Number(e.id)})">Изменить</button><button class="btn btn-sm" onclick="ecoDeleteEq(${Number(e.id)})">Удалить</button></div></td></tr>`).join('');
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">🔬 Аппараты</div><div class="bc-head-sub">В месяц = (цена − остаточная) / срок + ТО. Делится только между визитами привязанных услуг. Насадки и картриджи — в техкартах, здесь не дублировать</div></div>
      <div class="eco-actions">${_eco.equipment.length ? '' : '<button class="btn btn-sm" id="ecoEqSeed" onclick="ecoSeedEq()">Заполнить списком с сайта</button>'}<button class="btn btn-sm btn-pri" onclick="ecoEditEq(null)">+ Аппарат</button></div></div>
      <div id="ecoEqForm"></div>
      <div class="card eco-card-flush"><div class="tw"><table class="eco-tbl"><thead><tr><th>Аппарат</th><th class="num">Цена</th><th>Куплен</th><th class="num">Срок, мес</th><th class="num">Остаточная</th><th class="num">ТО/мес</th><th class="num">В месяц</th><th>Услуги</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">Реестр пуст — нажмите «Заполнить списком с сайта» или добавьте аппарат</td></tr>'}</tbody></table></div></div>`;
  } catch (e) { if (seq === _ecoEqSeq) el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoSeedEq() {
  const btn = document.getElementById('ecoEqSeed'); if (btn) btn.disabled = true;
  let done = 0;
  try {
    const { seed } = await api('GET', '/api/economics/equipment/seed');
    for (const s of seed) { await api('POST', '/api/economics/equipment', ecoSeedBody(s)); done++; }
    _eco.report = null; notify(`Добавлено аппаратов: ${done}. Проверьте цены и привяжите услуги`);
  } catch (e) { notify(`Добавлено ${done}, затем ошибка: ${e.message}`, 'err'); }
  finally { _eco.report = null; ecoLoadEquipment(); }
}
async function ecoEditEq(id) {
  let d;
  try { d = await ecoDicts(); } catch (e) { return notify('Ошибка: ' + e.message, 'err'); }
  const x = id ? (_eco.equipment || []).find(e => Number(e.id) === Number(id)) : { name: '', purchase_price: '', purchase_date: '', useful_life_months: 60, residual_pct: 0, maintenance_monthly: 0, service_ids: [], is_active: true, note: '' };
  if (!x) return notify('Аппарат не найден — обновите вкладку', 'err');
  const sel = (x.service_ids || []).map(String);
  const known = new Set((d.services || []).map(s => String(s.id)));
  const missing = sel.filter(i => !known.has(i)).map(i => `<option value="${escAttr(i)}" selected>id ${esc(i)} (нет в справочнике)</option>`).join('');
  const opts = missing + (d.services || []).map(s => `<option value="${escAttr(String(s.id))}" ${sel.includes(String(s.id)) ? 'selected' : ''}>${esc(ecoDictLabel(s))}</option>`).join('');
  const num = (v) => escAttr(v === '' || v === null || v === undefined ? '' : String(Number(v)));
  document.getElementById('ecoEqForm').innerHTML = `<div class="card eco-detail" style="margin-bottom:12px"><div class="eco-form">
    <div class="fg"><label class="fl">Название</label><input id="ecoEName" maxlength="255" value="${escAttr(x.name)}"></div>
    <div class="fg"><label class="fl">Цена покупки, ₽</label><input id="ecoEPrice" type="text" inputmode="decimal" value="${num(x.purchase_price)}"></div>
    <div class="fg"><label class="fl">Дата покупки</label><input id="ecoEDate" type="date" value="${escAttr(x.purchase_date || '')}"></div>
    <div class="fg"><label class="fl">Срок службы, мес</label><input id="ecoELife" type="text" inputmode="numeric" value="${escAttr(String(x.useful_life_months))}"></div>
    <div class="fg"><label class="fl">Остаточная, %</label><input id="ecoERes" type="text" inputmode="decimal" value="${num(x.residual_pct)}"></div>
    <div class="fg"><label class="fl">ТО в месяц, ₽</label><input id="ecoEMaint" type="text" inputmode="decimal" value="${num(x.maintenance_monthly)}"></div>
    <div class="fg"><label class="fl">Активен</label><select id="ecoEActive"><option value="1" ${x.is_active ? 'selected' : ''}>да</option><option value="0" ${!x.is_active ? 'selected' : ''}>нет</option></select></div>
    <div class="fg" style="grid-column:1/-1"><label class="fl">Услуги (Ctrl/⌘ — несколько)</label><select id="ecoESvc" multiple size="8">${opts}</select></div>
    <div class="fg" style="grid-column:1/-1"><label class="fl">Заметка</label><input id="ecoENote" maxlength="500" value="${escAttr(x.note || '')}"></div>
    </div><div class="eco-actions" style="margin-top:10px"><button class="btn btn-sm btn-pri" id="ecoESave" onclick="ecoSaveEq(${id ? Number(id) : 'null'})">Сохранить</button><button class="btn btn-sm" onclick="document.getElementById('ecoEqForm').innerHTML=''">Отмена</button></div></div>`;
}
async function ecoSaveEq(id) {
  const v = (i) => document.getElementById(i).value;
  const p = ecoParseEquipmentForm({ name: v('ecoEName'), price: v('ecoEPrice'), date: v('ecoEDate'), life: v('ecoELife'), residual: v('ecoERes'), maint: v('ecoEMaint'), active: v('ecoEActive'), note: v('ecoENote'),
    serviceIds: [...document.getElementById('ecoESvc').selectedOptions].map(o => o.value) });
  if (p.error) return notify(p.error, 'err');
  const btn = document.getElementById('ecoESave'); if (btn) btn.disabled = true;
  try { await api(id ? 'PUT' : 'POST', id ? `/api/economics/equipment/${Number(id)}` : '/api/economics/equipment', p.value); _eco.report = null; notify('Сохранено'); ecoLoadEquipment(); }
  catch (e) { if (btn) btn.disabled = false; notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteEq(id) {
  if (!confirm('Удалить аппарат?')) return;
  try { await api('DELETE', `/api/economics/equipment/${Number(id)}`); _eco.report = null; ecoLoadEquipment(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
