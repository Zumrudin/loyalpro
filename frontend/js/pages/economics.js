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
function ecoLoadGoods() {}
function ecoLoadTechCards() {}
function ecoLoadPay() {}
function ecoLoadFixed() {}
function ecoLoadEquipment() {}
function ecoLoadSettings() {}
