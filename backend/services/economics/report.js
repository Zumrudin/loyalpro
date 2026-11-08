'use strict';
// Склейка отчёта: store.loadPeriod → calc → aggregate. Кэш 60 с на ключ
// salon+from+to: один отчёт открывают несколько раз подряд (вкладки, детализация).
// Отчёт никогда не падает из-за отсутствия справочников: пустые правила/бюджет/
// аппараты и недоступный каталог YClients дают нули и флаги, не ошибку.
const store = require('./store');
const calc = require('./calc');
const { unitPriceAsOf, mskDay } = require('./price');
const { pickTechCard, suggestLinks } = require('./tech-cards');
const { periodFixedCosts, equipmentPeriodCost, daysInMonth, r2 } = require('./allocation');
const sync = require('./sync');
const { ycGetServiceMeta, ycGetServiceCatalog } = require('../yclients');
const { createLogger } = require('../../logger');
const logger = createLogger('EconomicsReport');

const TTL_MS = 60_000;
const CACHE_MAX = 50;       // кап ключей: период свободный, без вытеснения кэш рос бы без конца
const _cache = new Map();   // `${salonId}|${from}|${to}` → { ts, data }; порядок вставки = возраст

function cachePut(key, data) {
  const now = Date.now();
  for (const [k, v] of _cache) if (now - v.ts >= TTL_MS) _cache.delete(k);
  _cache.delete(key);
  _cache.set(key, { ts: now, data });
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}

// Поколения: invalidate чистит готовые записи, но отчёт, который СЧИТАЛСЯ во
// время мутации, иначе положил бы в кэш устаревший результат на TTL. Расчёт
// пишет в кэш, только если поколение салона (и общее) не сдвинулось с его начала.
const _gen = new Map();     // String(salonId) → n
let _epoch = 0;             // invalidate() без салона
const genOf = (salonId) => `${_epoch}|${_gen.get(String(salonId)) || 0}`;

function invalidate(salonId) {
  if (salonId === undefined) { _cache.clear(); _epoch++; return; }
  _gen.set(String(salonId), (_gen.get(String(salonId)) || 0) + 1);
  for (const k of [..._cache.keys()]) if (k.startsWith(`${salonId}|`)) _cache.delete(k);
}

/** Длительности, категории и названия услуг из каталога YClients; сбой → пустые карты + WARN. */
async function loadServiceMeta(salon) {
  const out = { durations: new Map(), categories: new Map(), titles: new Map(), staffByService: new Map() };
  try {
    const meta = await ycGetServiceMeta(salon);
    if (meta && meta.durationByService) out.durations = meta.durationByService;
    // Категории всех услуг, включая «инд.»: booking-каталог (priced ниже) их не
    // отдаёт, и категорийные правила оплаты на них не матчились бы. Та же
    // кэшированная выгрузка /company/{cid}/services/ — без лишнего запроса.
    if (meta && meta.categoryByService) for (const [k, v] of meta.categoryByService) out.categories.set(k, v);
  } catch (e) { logger.warn(`service meta: ${e.message}`); }
  try {
    const cat = await ycGetServiceCatalog(salon);
    for (const s of (cat && cat.priced) || []) {
      if (!out.categories.has(String(s.id)) || out.categories.get(String(s.id)) == null) {
        out.categories.set(String(s.id), s.category_id != null ? Number(s.category_id) : null);
      }
      out.titles.set(String(s.id), s.title || '');
    }
    if (cat && cat.staffIdsByService) out.staffByService = cat.staffIdsByService;
  } catch (e) { logger.warn(`service catalog: ${e.message}`); }
  return out;
}

function buildCtx(data, meta) {
  const priceMemo = new Map();
  const priceFn = (goodId, date) => {
    const k = `${goodId}|${date}`;
    if (!priceMemo.has(k)) priceMemo.set(k, unitPriceAsOf({
      receipts: data.receiptsByGood.get(Number(goodId)) || [], override: data.overridesByGood.get(Number(goodId)) || null,
      catalogRow: data.catalogByGood.get(Number(goodId)) || null, date }));
    return priceMemo.get(k);
  };
  const techCardFor = (serviceId, staffId) => {
    const link = pickTechCard(data.links, serviceId, staffId);
    return link ? data.cards.get(link.tech_card_id) || null : null;
  };
  return { durations: meta.durations, categories: meta.categories, priceFn, techCardFor, pay: data.pay, settings: data.settings };
}

async function compute(salon, from, to) {
  const data = await store.loadPeriod(salon.id, from, to);
  const meta = await loadServiceMeta(salon);
  const ctx = buildCtx(data, meta);
  const rows = data.records.flatMap(rec => calc.buildRows(rec, ctx));
  calc.finalizeRows(rows, { avgAcquiringRate: calc.avgAcquiringRate(rows) });
  const fixed = periodFixedCosts(data.fixedCosts, from, to);
  const equipment = data.equipment.map(eq => ({ id: eq.id, name: eq.name, service_ids: eq.service_ids, periodCost: equipmentPeriodCost(eq, from, to) }));
  const driver = data.settings.allocation_driver;
  calc.applyOverhead(rows, { driver, fixedTotal: fixed.total, equipment, usnRate: data.settings.usn_rate });
  const equipmentTotal = equipment.reduce((a, e) => a + e.periodCost, 0);
  const byService = calc.aggregate(rows, r => r.service_yc_id, r => r.service_title).sort((a, b) => b.revenue - a.revenue);
  const byServiceStaff = calc.aggregate(rows, r => `${r.service_yc_id}|${r.staff_yc_id}`, r => `${r.service_title} — ${r.staff_name}`)
    .map(g => ({ ...g, service_yc_id: Number(g.key.split('|')[0]), staff_yc_id: Number(g.key.split('|')[1]) || null }));
  const summary = { ...calc.summary(rows, { fixedTotal: fixed.total, capacityMinutes: data.capacityMinutes, driver, equipmentTotal }),
    fixed_by_category: fixed.byCategory, equipment: equipment.map(e => ({ id: e.id, name: e.name, period_cost: e.periodCost })) };
  summary.warnings = calc.warnings(rows, { receiptsByGood: data.receiptsByGood, catalogByGood: data.catalogByGood, from, to, today: mskDay(new Date()) });
  return { from, to, rows, byService, byServiceStaff, summary, settings: data.settings, meta, data };
}

async function buildReport(salon, from, to, { force = false } = {}) {
  const key = `${salon.id}|${from}|${to}`;
  const hit = _cache.get(key);
  if (!force && hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  const gen = genOf(salon.id);
  const data = await compute(salon, from, to);
  if (genOf(salon.id) === gen) cachePut(key, data);
  return data;
}

/** Детализация услуги: статьи, по сотрудникам, визиты со строками и флагами. */
async function serviceDetail(salon, serviceId, from, to) {
  const r = await buildReport(salon, from, to);
  const sid = Number(serviceId);
  const rows = r.rows.filter(x => x.service_yc_id === sid);
  if (!rows.length) return null;
  const [service] = calc.aggregate(rows, () => sid, x => x.service_title);
  const byStaff = calc.aggregate(rows, x => x.staff_yc_id, x => x.staff_name).sort((a, b) => b.revenue - a.revenue);
  const visits = rows.map(x => ({
    record_id: x.record_id, visit_date: x.visit_date, staff_name: x.staff_name, price: x.price, first_cost: x.first_cost, discount: x.discount, bonus_redeemed: x.bonus_redeemed, bonus_applied: x.bonus_applied,
    revenue: x.revenue, materials_used: x.materials_used, materials_fact: x.materials_fact, materials_norm: x.materials_norm, materials_yc_cost: x.materials_yc_cost,
    materials_estimated: x.materials_estimated, no_materials_data: x.no_materials_data, no_price_goods: x.no_price_goods,
    doctor_cost: x.doctor_cost, no_pay_rule: x.no_pay_rule, pay_scheme_id: x.pay_scheme_id, pay_line_idx: x.pay_line_idx, acquiring_cost: x.acquiring_cost, acquiring_estimated: x.acquiring_estimated,
    contribution: x.contribution, overhead: x.overhead, equipment_cost: x.equipment_cost, operating_profit: x.operating_profit, minutes: x.minutes,
  })).sort((a, b) => b.visit_date.localeCompare(a.visit_date) || b.record_id - a.record_id);
  return { service, byStaff, visits, settings: r.settings };
}

/** Покрытие техкартами: услуги периода, доля визитов со списаниями, привязка, подсказки. */
async function coverage(salon, from, to) {
  const r = await buildReport(salon, from, to);
  const cards = [...r.data.cards.values()].map(c => ({ id: c.id, yc_card_id: c.yc_card_id, title: c.title, source: c.source, items: c.items }));
  const byService = new Map();
  for (const x of r.rows) {
    const s = byService.get(x.service_yc_id) || { service_yc_id: x.service_yc_id, title: x.service_title, visits: new Set(), cons: 0, rows: 0, staff: new Set() };
    s.visits.add(x.record_id); s.rows++; if (x.has_consumables) s.cons++; if (x.staff_yc_id != null) s.staff.add(x.staff_yc_id);
    byService.set(x.service_yc_id, s);
  }
  const services = [...byService.values()].map(s => {
    const link = pickTechCard(r.data.links, s.service_yc_id, null) || r.data.links.find(l => l.service_yc_id === s.service_yc_id) || null;
    const card = link ? r.data.cards.get(link.tech_card_id) : null;
    const sugg = card ? [] : suggestLinks(cards, [{ id: s.service_yc_id, title: s.title }]);
    return { service_yc_id: s.service_yc_id, title: s.title, visits: s.visits.size, consumables_share: s.rows ? s.cons / s.rows : 0,
      staff_yc_ids: [...s.staff], tech_card: card ? { id: card.id, title: card.title, source: link.source, staff_yc_id: link.staff_yc_id, items: card.items } : null,
      suggestions: sugg };
  }).sort((a, b) => b.visits - a.visits);
  return { services, cards };
}

const MAX_PAYROLL_STAFF = 40;   // по запросу в YClients на сотрудника — кап на случай разросшегося штата

/** Σ doctor_pay по сотруднику за месяц (строки calc: фикс за визит уже поделён на запись)
 *  против salary/period YClients. Нет ответа YClients → yc_salary/diff = null. */
async function payrollCheck(salon, month) {
  const from = `${month}-01`, to = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const r = await buildReport(salon, from, to);
  const byStaff = calc.aggregate(r.rows.filter(x => x.staff_yc_id != null), x => x.staff_yc_id, x => x.staff_name)
    .sort((a, b) => b.doctor_pay - a.doctor_pay);
  const rows = [];
  for (const g of byStaff.slice(0, MAX_PAYROLL_STAFF)) {
    let yc = null, error = null;
    try { yc = await sync.fetchStaffSalary(salon, g.key, from, to); } catch (e) { error = e.message || 'ошибка'; }
    const ycSalary = yc && yc.salary !== null && yc.salary !== undefined ? yc.salary : null;
    rows.push({ staff_yc_id: g.key, staff_name: g.label, visits: g.visits, our_pay: g.doctor_pay, our_cost: g.doctor_cost,
      no_pay_rule_rows: g.coverage.no_pay_rule,
      yc_salary: ycSalary, yc_hours: yc ? yc.working_hours_count : null, diff: ycSalary === null ? null : r2(g.doctor_pay - ycSalary), error });
  }
  return { month, from, to, rows, truncated: byStaff.length > MAX_PAYROLL_STAFF };
}

module.exports = { payrollCheck, buildReport, serviceDetail, coverage, invalidate, loadServiceMeta, TTL_MS, CACHE_MAX, _cacheSize: () => _cache.size };
