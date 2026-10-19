'use strict';
// Расчёт экономики по строке «запись × услуга» (§3.1–3.7 спеки). Чистый модуль:
// без БД и HTTP, все входы — через record/ctx. Деньги не округляются по ходу —
// копейки появляются только там, где делится общая сумма (splitByWeights: доли
// сходятся с итогом) и на выдаче агрегатов (r2).
const { splitByWeights, splitMinutes, allocate, r2 } = require('./allocation');
const { pickRule, doctorPay } = require('./pay-rules');
const { normCost } = require('./tech-cards');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const has = (v) => v !== undefined && v !== null;

/**
 * Одна запись → строки по услугам (§3.1–3.5).
 * record = { record_id, visit_date:'YYYY-MM-DD', staff_yc_id, staff_name, seance_length (сек),
 *   services:[{id,title,cost_to_pay,first_cost,cost}], consumables:[{good_id, service_id|null, amount, cost}],
 *   bonus_redeemed, payments:[{amount, account_title}] }
 * ctx = { durations: Map<svcIdStr,сек>, categories: Map<svcIdStr,catId>, priceFn(goodId,date)→{price,source},
 *   techCardFor(serviceId, staffId)→card|null, payRules:[…],
 *   settings:{payroll_multiplier, pay_base_includes_bonuses, acquiring:{[account_title]:pct}} }
 * Эквайринг без привязанных оплат остаётся null — его дооценивает finalizeRows
 * (нужна средняя доля периода), там же считается маржинальная прибыль.
 */
function buildRows(record, ctx) {
  const services = (Array.isArray(record.services) ? record.services : [])
    .map(s => ({
      id: Number(s.id), title: String(s.title || ''),
      price: n(has(s.cost_to_pay) ? s.cost_to_pay : s.cost),
      first_cost: n(has(s.first_cost) ? s.first_cost : s.cost),
    })).filter(s => s.id);
  if (!services.length) return [];
  const staffId = has(record.staff_yc_id) ? Number(record.staff_yc_id) : null;
  const date = record.visit_date;
  const settings = (ctx && ctx.settings) || {};
  const durations = (ctx && ctx.durations) || new Map();
  const categories = (ctx && ctx.categories) || new Map();
  const priceFn = (ctx && ctx.priceFn) || (() => ({ price: 0, source: 'none' }));
  const techCardFor = (ctx && ctx.techCardFor) || (() => null);
  const prices = services.map(s => s.price);
  const minutes = splitMinutes(record.seance_length, services.map(s => durations.get(String(s.id)) || 0));
  const bonusParts = splitByWeights(n(record.bonus_redeemed), prices);

  // Списания (§3.2): со своей услугой — на её строку; без service_id (или с service_id,
  // которого в записи нет) — на запись, делятся между услугами по доле цены.
  const cons = Array.isArray(record.consumables) ? record.consumables : [];
  const hasCons = cons.length > 0;
  const own = new Map(services.map(s => [s.id, { fact: 0, yc: 0, noPrice: [] }]));
  const rec = { fact: 0, yc: 0, noPrice: [] };
  for (const t of cons) {
    const qty = Math.abs(n(t.amount));
    const goodId = Number(t.good_id);
    const p = priceFn(goodId, date) || { price: 0 };
    const target = own.get(Number(t.service_id)) || rec;
    target.fact += qty * n(p.price);
    target.yc += Math.abs(n(t.cost));
    if (!(n(p.price) > 0) && qty > 0) target.noPrice.push(goodId);
  }
  const recFact = splitByWeights(rec.fact, prices);
  const recYc = splitByWeights(rec.yc, prices);

  // Эквайринг по кассам (§3.4): только когда оплаты привязаны к записи; касса без
  // процента в настройках = 0 (это не оценка, оплаты известны).
  const payments = Array.isArray(record.payments) ? record.payments : [];
  const pct = settings.acquiring || {};
  const acqTotal = payments.reduce((a, p) => a + n(p.amount) * (n(pct[p.account_title]) / 100), 0);
  const acqParts = splitByWeights(acqTotal, prices);

  // Правило оплаты (§3.3) выбирается на каждую строку; fixed_per_visit — «за визит»,
  // поэтому у правила, под которое попало несколько строк ОДНОЙ записи, фикс берётся
  // один раз и делится между ними по цене (иначе общее правило сотрудника с фиксом
  // начисляло бы его на каждую услугу записи).
  const rules = services.map(s => {
    const categoryId = categories.has(String(s.id)) ? categories.get(String(s.id)) : null;
    return { categoryId, rule: pickRule((ctx && ctx.payRules) || [], { staffId, serviceId: s.id, categoryId, date }) };
  });
  const fixedShare = services.map(() => 0);
  const byRule = new Map();
  rules.forEach((r, i) => { if (r.rule) { const k = String(r.rule.id); if (!byRule.has(k)) byRule.set(k, []); byRule.get(k).push(i); } });
  for (const idx of byRule.values()) {
    const fixed = n(rules[idx[0]].rule.fixed_per_visit);
    if (idx.length === 1 || !fixed) { idx.forEach(i => { fixedShare[i] = fixed; }); continue; }
    const parts = splitByWeights(fixed, idx.map(i => prices[i]));
    idx.forEach((i, k) => { fixedShare[i] = parts[k]; });
  }

  return services.map((s, i) => {
    const o = own.get(s.id);
    const materials_fact = o.fact + recFact[i];
    const card = techCardFor(s.id, staffId);
    const norm = card ? normCost(card, priceFn, date) : null;
    const materials_norm = norm ? norm.cost : null;
    const materials_used = hasCons ? materials_fact : (norm ? norm.cost : 0);
    const bonus = bonusParts[i];
    const revenue = s.price - bonus;
    const { categoryId, rule } = rules[i];
    const dp = doctorPay({ price: s.price, revenue, materials_used }, rule ? { ...rule, fixed_per_visit: fixedShare[i] } : null, settings);
    const noPriceGoods = [...new Set([...o.noPrice, ...rec.noPrice, ...(hasCons ? [] : (norm ? norm.noPrice : []))])]
      .map(Number).sort((a, b) => a - b);
    return {
      record_id: record.record_id, visit_date: date, staff_yc_id: staffId, staff_name: record.staff_name || '',
      service_yc_id: s.id, service_title: s.title, category_yc_id: categoryId,
      price: s.price, first_cost: s.first_cost, discount: Math.max(0, s.first_cost - s.price),
      minutes: minutes[i], hours: minutes[i] / 60,
      bonus_redeemed: bonus, revenue,
      materials_fact, materials_yc_cost: o.yc + recYc[i], materials_norm, materials_used,
      materials_estimated: !hasCons && !!norm, no_materials_data: !hasCons && !norm,
      has_consumables: hasCons, has_tech_card: !!card, no_price_goods: noPriceGoods,
      pay_rule_id: rule ? rule.id : null, pay_base: dp.base, doctor_pay: dp.pay, doctor_cost: dp.cost, no_pay_rule: dp.noRule,
      has_payments: payments.length > 0,
      acquiring_cost: payments.length ? acqParts[i] : null, acquiring_estimated: payments.length === 0,
      contribution: null, contribution_pct: null,
      overhead: 0, equipment_cost: 0, operating_profit: null, operating_pct: null, usn_estimate: 0, profit_per_hour: null,
    };
  });
}

/** Средняя доля эквайринга по строкам с привязанными оплатами (§3.4) — для оценки у остальных. */
function avgAcquiringRate(rows) {
  let acq = 0, rev = 0;
  for (const r of rows) if (r.has_payments) { acq += n(r.acquiring_cost); rev += n(r.revenue); }
  return rev > 0 ? acq / rev : 0;
}

/** Дооценка эквайринга без оплат и маржинальная прибыль (§3.5). Мутирует rows. */
function finalizeRows(rows, { avgAcquiringRate: avg = 0 } = {}) {
  for (const r of rows) {
    if (r.acquiring_cost === null || r.acquiring_cost === undefined) r.acquiring_cost = r.revenue * n(avg);
    r.contribution = r.revenue - r.materials_used - r.doctor_cost - r.acquiring_cost;
    r.contribution_pct = r.revenue > 0 ? r.contribution / r.revenue : null;
  }
  return rows;
}

/**
 * Постоянные расходы и аппараты по драйверу (§3.6); операционная прибыль, оценка УСН,
 * прибыль/час. Мутирует rows; повторный вызов пересчитывает, а не накапливает.
 * equipment: [{ id, name, service_ids:[…], periodCost }] — periodCost уже за период.
 */
function applyOverhead(rows, { driver = 'minutes', fixedTotal = 0, equipment = [], usnRate = 15 } = {}) {
  const ov = allocate(rows, driver, n(fixedTotal));
  rows.forEach((r, i) => { r.overhead = ov[i]; r.equipment_cost = 0; });
  for (const eq of equipment || []) {
    const ids = new Set((eq.service_ids || []).map(Number));
    if (!ids.size || !(n(eq.periodCost) > 0)) continue;
    const parts = allocate(rows, driver, n(eq.periodCost), ids);
    rows.forEach((r, i) => { r.equipment_cost += parts[i]; });
  }
  for (const r of rows) {
    r.operating_profit = n(r.contribution) - r.overhead - r.equipment_cost;
    r.operating_pct = r.revenue > 0 ? r.operating_profit / r.revenue : null;
    r.usn_estimate = Math.max(0, r.operating_profit) * n(usnRate) / 100;
    r.profit_per_hour = r.hours > 0 ? n(r.contribution) / r.hours : null;
  }
  return rows;
}

const SUM_FIELDS = ['price', 'discount', 'bonus_redeemed', 'revenue', 'materials_fact', 'materials_yc_cost', 'materials_used',
  'doctor_pay', 'doctor_cost', 'acquiring_cost', 'contribution', 'overhead', 'equipment_cost', 'operating_profit', 'usn_estimate', 'minutes'];

/** Группировка строк (§3.7). keyFn/labelFn — по услуге, по услуге×сотруднику и т.д. Суммы округлены на выдаче. */
function aggregate(rows, keyFn, labelFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: labelFn ? labelFn(r) : String(key), rows: 0, _records: new Set(),
        materials_norm: 0, materials_norm_rows: 0, materials_estimated_sum: 0, materials_estimated_rows: 0,
        coverage: { rows: 0, with_consumables: 0, with_tech_card: 0, no_pay_rule: 0, no_price_goods: new Set(), acquiring_estimated: 0 } };
      for (const f of SUM_FIELDS) g[f] = 0;
      groups.set(key, g);
    }
    g.rows++; g._records.add(r.record_id);
    for (const f of SUM_FIELDS) g[f] += n(r[f]);
    if (has(r.materials_norm)) { g.materials_norm += n(r.materials_norm); g.materials_norm_rows++; }
    if (r.materials_estimated) { g.materials_estimated_sum += n(r.materials_used); g.materials_estimated_rows++; }
    const c = g.coverage;
    c.rows++;
    if (r.has_consumables) c.with_consumables++;
    if (r.has_tech_card) c.with_tech_card++;
    if (r.no_pay_rule) c.no_pay_rule++;
    if (r.acquiring_estimated) c.acquiring_estimated++;
    for (const gid of r.no_price_goods || []) c.no_price_goods.add(gid);
  }
  return [...groups.values()].map(g => {
    const out = { ...g, visits: g._records.size, hours: g.minutes / 60 };
    delete out._records;
    out.contribution_pct = g.revenue > 0 ? g.contribution / g.revenue : null;
    out.operating_pct = g.revenue > 0 ? g.operating_profit / g.revenue : null;
    out.profit_per_hour = out.hours > 0 ? g.contribution / out.hours : null;
    out.coverage = { ...g.coverage, no_price_goods: [...g.coverage.no_price_goods].sort((a, b) => a - b) };
    for (const f of SUM_FIELDS) out[f] = r2(out[f]);
    out.materials_norm = r2(out.materials_norm); out.materials_estimated_sum = r2(out.materials_estimated_sum);
    return out;
  });
}

/**
 * Сводка периода (§3.6, 3.7): итоги, ставка минуты фактическая и при плановой мощности,
 * цена простоя (на уровне периода, не услуги), покрытие данными.
 * capacityMinutes — Σ work_minutes графика за период; 0/нет → ставка 0, простой null.
 */
function summary(rows, { fixedTotal = 0, capacityMinutes = 0, driver = 'minutes', equipmentTotal = 0 } = {}) {
  const minutes = rows.reduce((a, r) => a + n(r.minutes), 0);
  const records = new Set(rows.map(r => r.record_id));
  const raw = {};
  for (const f of SUM_FIELDS) raw[f] = rows.reduce((a, r) => a + n(r[f]), 0);
  const tot = {};
  for (const f of SUM_FIELDS) tot[f] = r2(raw[f]);
  const rateFact = minutes > 0 ? n(fixedTotal) / minutes : 0;
  const rateCap = n(capacityMinutes) > 0 ? n(fixedTotal) / n(capacityMinutes) : 0;
  const services = new Map();
  const staff = new Map();
  for (const r of rows) {
    const s = services.get(r.service_yc_id) || { tech: false, cons: 0, rows: 0 };
    s.tech = s.tech || !!r.has_tech_card; s.cons += r.has_consumables ? 1 : 0; s.rows++;
    services.set(r.service_yc_id, s);
    if (has(r.staff_yc_id)) staff.set(r.staff_yc_id, (staff.get(r.staff_yc_id) || false) || !r.no_pay_rule);
  }
  const noPrice = new Set(); rows.forEach(r => (r.no_price_goods || []).forEach(g => noPrice.add(g)));
  return {
    ...tot, visits: records.size, rows: rows.length, minutes, hours: minutes / 60, driver,
    fixed_total: r2(n(fixedTotal)), equipment_total: r2(n(equipmentTotal)),
    rate_minute_fact: rateFact, rate_minute_capacity: rateCap, capacity_minutes: n(capacityMinutes),
    idle_cost: n(capacityMinutes) > 0 ? r2(Math.max(0, n(fixedTotal) - rateCap * minutes)) : null,
    contribution_pct: raw.revenue > 0 ? raw.contribution / raw.revenue : null,
    operating_pct: raw.revenue > 0 ? raw.operating_profit / raw.revenue : null,
    coverage: {
      consumables_share: rows.length ? rows.filter(r => r.has_consumables).length / rows.length : 0,
      services_without_tech_card: [...services.values()].filter(s => !s.tech).length,
      services_total: services.size,
      goods_without_price: [...noPrice].sort((a, b) => a - b),
      staff_without_pay_rule: [...staff.values()].filter(ok => !ok).length,
      acquiring_estimated_share: rows.length ? rows.filter(r => r.acquiring_estimated).length / rows.length : 0,
    },
  };
}

module.exports = { buildRows, avgAcquiringRate, finalizeRows, applyOverhead, aggregate, summary, SUM_FIELDS };
