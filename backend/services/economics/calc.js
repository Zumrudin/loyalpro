'use strict';
// Расчёт экономики по строке «запись × услуга» (§3.1–3.7 спеки). Чистый модуль:
// без БД и HTTP, все входы — через record/ctx. Деньги не округляются по ходу —
// копейки появляются только там, где делится общая сумма (splitByWeights: доли
// сходятся с итогом) и на выдаче агрегатов (r2).
const { splitByWeights, splitMinutes, allocate, r2 } = require('./allocation');
const { pickRule, doctorPay } = require('./pay-rules');
const { normCost } = require('./tech-cards');
const { receiptUnitPrice, mskDay, writeoffQty } = require('./price');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const has = (v) => v !== undefined && v !== null;

/**
 * Одна запись → строки по услугам (§3.1–3.5).
 * record = { record_id, visit_date:'YYYY-MM-DD', staff_yc_id, staff_name, seance_length (сек),
 *   services:[{id,title,cost_to_pay,first_cost,cost}], consumables:[{good_id, service_id|null, amount, cost, cost_per_unit, unit_equals}],
 *   bonus_redeemed, payments:[{amount, account_title}] }
 * ctx = { durations: Map<svcIdStr,сек>, categories: Map<svcIdStr,catId>, priceFn(goodId,date)→{price,source},
 *   techCardFor(serviceId, staffId)→card|null, payRules:[…],
 *   settings:{payroll_multiplier, pay_base_includes_bonuses, acquiring:{[account_title]:pct}} }
 * Эквайринг без привязанных оплат остаётся null — его дооценивает finalizeRows
 * (нужна средняя доля периода), там же считается маржинальная прибыль.
 */
function buildRows(record, ctx) {
  const services = (Array.isArray(record.services) ? record.services : [])
    .map(s => {
      // Количество услуги в записи: first_cost YClients — цена ЕДИНИЦЫ, cost/cost_to_pay —
      // уже за все единицы, техкарта — на одну («Revi strong 2 ml» × 2: два шприца).
      const qty = Number(s.amount) > 0 ? Number(s.amount) : 1;
      // Прайс (first_cost × qty) и «к оплате деньгами» (cost_to_pay; нет — cost). Разрыв
      // между ними объясняется бонусами и скидкой — делится ниже по записи.
      const price = n(has(s.cost_to_pay) ? s.cost_to_pay : s.cost);
      const first = has(s.first_cost) ? n(s.first_cost) * qty : n(has(s.cost) ? s.cost : price);
      return { id: Number(s.id), title: String(s.title || ''), qty, price, first_cost: first, gap: Math.max(0, first - price) };
    }).filter(s => s.id);
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
  // Бонусы и скидки (§3.1; правило с 19.10.2026, разбор записи 2006141556): выручка =
  // cost_to_pay ВСЕГДА. YClients вычитает списанные бонусы либо в cost_to_pay (Profhilo
  // 26000 → cost 26000, cost_to_pay 23400), либо в cost И cost_to_pay сразу (Боташев 08.10:
  // first_cost 21000, cost = cost_to_pay 20300, discount 0 — бонус 1500 записи разложен по
  // услугам пропорционально цене), и платёжные операции по записи равны cost_to_pay в
  // 254 визитах из 256 с бонусами за 01.07–18.10.2026. Прежняя эвристика «вычтено =
  // Σcost − Σcost_to_pay» на второй форме давала 0 и вычитала бонус второй раз, а
  // first_cost − cost показывала скидкой. Случая «деньгами cost_to_pay − бонус» в данных
  // нет: строки списаний у нас производные (дельта баланса карты на платёжной операции,
  // loyalty.js) и включают списания за товары и дрейф баланса — поэтому бонус СВЕРХ
  // разрыва до прайса выручку не трогает и остаётся справочным (bonus_redeemed).
  // bonus_applied — часть бонуса, объясняющая разрыв first_cost×amount − cost_to_pay
  // (делится по разрывам услуг, не по цене: услуга без разрыва бонуса не получала);
  // остаток разрыва — скидка. База оплаты врача «до бонусов» = price + bonus_applied.
  // ОСОЗНАННО: абонементный визит (cost_to_pay 0 при first_cost 6000) даёт выручку 0 и
  // разрыв показывает скидкой — признавать ли долю абонемента выручкой, решает владелец.
  const bonusRedeemed = n(record.bonus_redeemed);
  const gaps = services.map(s => s.gap);
  const gapTotal = gaps.reduce((a, g) => a + g, 0);
  const bonusParts = splitByWeights(bonusRedeemed, prices);
  const bonusAppliedParts = splitByWeights(Math.min(bonusRedeemed, gapTotal), gaps);

  // Списания (§3.2): со своей услугой — на её строку; без service_id (или с service_id,
  // которого в записи нет) — на запись, делятся между услугами по доле цены. Услуга,
  // стоящая в записи несколько раз, получает ОДНУ корзину: её списания делятся между
  // её строками по цене (иначе каждая строка получала бы весь факт).
  const cons = Array.isArray(record.consumables) ? record.consumables : [];
  const hasCons = cons.length > 0;
  const own = new Map();
  services.forEach((s, i) => {
    if (!own.has(s.id)) own.set(s.id, { fact: 0, yc: 0, noPrice: [], idx: [] });
    own.get(s.id).idx.push(i);
  });
  const rec = { fact: 0, yc: 0, noPrice: [] };
  for (const t of cons) {
    // amount бывает в единицах продажи — writeoffQty приводит к единице списания (цене priceFn).
    const qty = writeoffQty(t, t.unit_equals);
    const goodId = Number(t.good_id);
    const p = priceFn(goodId, date) || { price: 0 };
    const target = own.get(Number(t.service_id)) || rec;
    target.fact += qty * n(p.price);
    target.yc += Math.abs(n(t.cost));
    if (!(n(p.price) > 0) && qty > 0) target.noPrice.push(goodId);
  }
  const ownFact = services.map(() => 0);
  const ownYc = services.map(() => 0);
  for (const o of own.values()) {
    const w = o.idx.map(i => prices[i]);
    const f = o.idx.length === 1 ? [o.fact] : splitByWeights(o.fact, w);
    const y = o.idx.length === 1 ? [o.yc] : splitByWeights(o.yc, w);
    o.idx.forEach((i, k) => { ownFact[i] = f[k]; ownYc[i] = y[k]; });
  }
  // Общие списания записи делятся по цене между РАЗНЫМИ услугами — у такой строки
  // факт материалов это оценка доли, а не то, что реально ушло на услугу.
  const factShared = rec.fact + rec.yc > 0 && own.size > 1;
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
    const materials_fact = ownFact[i] + recFact[i];
    const card = techCardFor(s.id, staffId);
    const norm1 = card ? normCost(card, priceFn, date) : null;
    const norm = norm1 ? { ...norm1, cost: norm1.cost * s.qty } : null;
    const materials_norm = norm ? norm.cost : null;
    const materials_used = hasCons ? materials_fact : (norm ? norm.cost : 0);
    const bonus = bonusParts[i];
    const bonusApplied = bonusAppliedParts[i];
    const revenue = s.price;
    const { categoryId, rule } = rules[i];
    // price для doctorPay — база «до бонусов» (pay_base_includes_bonuses): к оплате плюс
    // бонусы, которые YClients уже вычел из неё (Profhilo 23400 + 2600 → 26000).
    const dp = doctorPay({ price: s.price + bonusApplied, revenue, materials_used }, rule ? { ...rule, fixed_per_visit: fixedShare[i] } : null, settings);
    const noPriceConsumed = [...new Set([...o.noPrice, ...rec.noPrice])].map(Number).sort((a, b) => a - b);
    const noPriceGoods = [...new Set([...noPriceConsumed, ...(hasCons ? [] : (norm ? norm.noPrice : []))])]
      .map(Number).sort((a, b) => a - b);
    return {
      record_id: record.record_id, visit_date: date, staff_yc_id: staffId, staff_name: record.staff_name || '',
      service_yc_id: s.id, service_title: s.title, category_yc_id: categoryId,
      price: s.price, first_cost: s.first_cost, discount: Math.max(0, s.gap - bonusApplied),
      minutes: minutes[i], hours: minutes[i] / 60,
      bonus_redeemed: bonus, bonus_applied: bonusApplied, revenue,
      materials_fact, materials_yc_cost: ownYc[i] + recYc[i], materials_norm, materials_used,
      materials_estimated: !hasCons && !!norm, no_materials_data: !hasCons && !norm,
      has_consumables: hasCons, has_tech_card: !!card, no_price_goods: noPriceGoods,
      // Для предупреждений (Task 22): товары без цены именно из РЕАЛЬНЫХ списаний;
      // норма посчитана по всем своим товарам; факт строки включает долю общих списаний.
      no_price_consumed: noPriceConsumed, norm_complete: !!norm && norm.noPrice.length === 0, fact_shared: factShared,
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

const SUM_FIELDS = ['price', 'first_cost', 'discount', 'bonus_redeemed', 'bonus_applied', 'revenue', 'materials_fact', 'materials_yc_cost', 'materials_used',
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

const OVERRUN_RATIO = 1.2;
const PRICE_JUMP_RATIO = 1.2;
const ratio2 = (a, b) => Math.round(a / b * 100) / 100;

/** Цена единицы списания по дням: { day → средняя по СОПОСТАВИМЫМ приходам дня }.
 *  Приход в упаковках без unit_equals (receiptUnitPrice → null) и бесплатный (0) — не в счёт. */
function receiptDayPrices(receipts, unitEquals) {
  const days = new Map();
  for (const r of receipts || []) {
    const day = mskDay(r && r.create_date);
    const per = receiptUnitPrice(r, unitEquals);
    if (!day || !(per > 0)) continue;
    const qty = Math.abs(Number(r.amount)) * (Number(r.operation_unit_type) === 1 ? Number(unitEquals) : 1);
    const d = days.get(day) || { cost: 0, qty: 0 };
    d.cost += per * qty; d.qty += qty; days.set(day, d);
  }
  return [...days.entries()].map(([day, d]) => ({ day, price: Math.round(d.cost / d.qty * 10000) / 10000 }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * Предупреждения периода (Task 22). Правило: нет источника данных — нет предупреждения.
 *  - no_consumables: у услуги есть норма (техкарта с товарами), а визит без единого
 *    списания; визиты сегодня и позже не считаются — списание ещё могут провести;
 *    день, в который НИ У ОДНОЙ записи салона нет списаний, — тоже: это дыра синка,
 *    а не «не списали» (дев 19.10.2026: товары с 01.09, неделя 05–11.10 пустая целиком).
 *  - overrun: факт своих списаний услуги > нормы × 1,2; норма полная (все товары с
 *    ценой), факт не является долей общих списаний записи.
 *  - no_price: товар реально списан в периоде, а цены нет ни в приходах, ни вручную, ни в каталоге.
 *  - price_jump: последний день приходов в периоде против предыдущего дня приходов,
 *    оба в сопоставимых единицах (единица списания), рост ≥ 20 %.
 * rows — строки buildRows; receiptsByGood — приходы до конца периода; today — 'YYYY-MM-DD' мск.
 */
function warnings(rows, { receiptsByGood = new Map(), catalogByGood = new Map(), from, to, today } = {}) {
  const noCons = new Map();
  const overrun = [];
  const noPrice = new Map();
  const title = (gid) => (catalogByGood.get(gid) || {}).title || `товар ${gid}`;
  const consDays = new Set((rows || []).filter(r => r.has_consumables).map(r => r.visit_date));
  for (const r of rows || []) {
    if (!r.has_consumables && r.has_tech_card && has(r.materials_norm) && consDays.has(r.visit_date)
      && !(today && r.visit_date >= today)) {
      const s = noCons.get(r.service_yc_id) || { type: 'no_consumables', service_yc_id: r.service_yc_id, service_title: r.service_title, count: 0, record_ids: [], last_date: null };
      if (!s.record_ids.includes(r.record_id)) {
        s.record_ids.push(r.record_id); s.count++;
        if (!s.last_date || r.visit_date > s.last_date) s.last_date = r.visit_date;
      }
      noCons.set(r.service_yc_id, s);
    }
    if (r.has_consumables && r.norm_complete && !r.fact_shared && n(r.materials_norm) > 0
      && n(r.materials_fact) > n(r.materials_norm) * OVERRUN_RATIO) {
      overrun.push({ type: 'overrun', service_yc_id: r.service_yc_id, service_title: r.service_title, record_id: r.record_id,
        visit_date: r.visit_date, staff_name: r.staff_name || '', fact: r2(r.materials_fact), norm: r2(r.materials_norm), ratio: ratio2(n(r.materials_fact), n(r.materials_norm)) });
    }
    for (const gid of r.no_price_consumed || []) {
      const g = noPrice.get(gid) || { type: 'no_price', good_id: gid, good_title: title(gid), _rec: new Set() };
      g._rec.add(r.record_id); noPrice.set(gid, g);
    }
  }
  const jumps = [];
  for (const [gid, receipts] of receiptsByGood || []) {
    const cat = catalogByGood.get(gid) || {};
    const days = receiptDayPrices(receipts, cat.unit_equals);
    const last = days.find(d => d.day >= from && d.day <= to);
    if (!last) continue;
    const prev = days.find(d => d.day < last.day);
    if (!prev) continue;
    if (last.price / prev.price >= PRICE_JUMP_RATIO) {
      jumps.push({ type: 'price_jump', good_id: gid, good_title: title(gid), prev: prev.price, prev_at: prev.day, last: last.price, ratio: ratio2(last.price, prev.price), at: last.day });
    }
  }
  return [
    ...[...noCons.values()].sort((a, b) => b.count - a.count || a.service_yc_id - b.service_yc_id),
    ...overrun.sort((a, b) => b.ratio - a.ratio || a.record_id - b.record_id),
    ...[...noPrice.values()].map(({ _rec, ...g }) => ({ ...g, visits: _rec.size })).sort((a, b) => b.visits - a.visits || a.good_id - b.good_id),
    ...jumps.sort((a, b) => b.ratio - a.ratio || a.good_id - b.good_id),
  ];
}

module.exports = { warnings, receiptDayPrices, OVERRUN_RATIO, PRICE_JUMP_RATIO, buildRows, avgAcquiringRate, finalizeRows, applyOverhead, aggregate, summary, SUM_FIELDS };
