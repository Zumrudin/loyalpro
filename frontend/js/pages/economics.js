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
function ecoLoadServices() {}
function ecoLoadGoods() {}
function ecoLoadTechCards() {}
function ecoLoadPay() {}
function ecoLoadFixed() {}
function ecoLoadEquipment() {}
function ecoLoadSettings() {}
