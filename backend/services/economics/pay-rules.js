'use strict';
// Правила оплаты врача (§3.3 спеки). Приоритет: услуга у сотрудника → услуга →
// категория у сотрудника → категория → сотрудник целиком → салон по умолчанию;
// у каждого правила период действия (строки 'YYYY-MM-DD', NULL = открыт).
function eq(a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b); }
function isNull(v) { return v === null || v === undefined; }
function day(v) { return v ? String(v).slice(0, 10) : null; }

function ruleRank(r) {
  if (!isNull(r.service_yc_id)) return isNull(r.staff_yc_id) ? 1 : 0;
  if (!isNull(r.category_yc_id)) return isNull(r.staff_yc_id) ? 3 : 2;
  if (!isNull(r.staff_yc_id)) return 4;
  return 5;
}

function pickRule(rules, { staffId, serviceId, categoryId, date }) {
  const d = day(date);
  const cands = (rules || []).filter(r =>
    (isNull(r.staff_yc_id) || eq(r.staff_yc_id, staffId))
    && (isNull(r.service_yc_id) || eq(r.service_yc_id, serviceId))
    && (isNull(r.category_yc_id) || eq(r.category_yc_id, categoryId))
    && (!day(r.valid_from) || !d || day(r.valid_from) <= d)
    && (!day(r.valid_to) || !d || day(r.valid_to) >= d));
  if (!cands.length) return null;
  cands.sort((a, b) => ruleRank(a) - ruleRank(b)
    || String(day(b.valid_from) || '').localeCompare(String(day(a.valid_from) || ''))
    || Number(b.id || 0) - Number(a.id || 0));
  return cands[0];
}

/** row: {price, revenue, materials_used}; settings: {payroll_multiplier, pay_base_includes_bonuses}. */
function doctorPay(row, rule, settings = {}) {
  if (!rule) return { base: 0, pay: 0, cost: 0, noRule: true };
  const mult = Number(settings.payroll_multiplier) > 0 ? Number(settings.payroll_multiplier) : 1;
  const start = settings.pay_base_includes_bonuses ? Number(row.price) || 0 : Number(row.revenue) || 0;
  const base = rule.base === 'net_of_materials' ? start - (Number(row.materials_used) || 0) : start;
  const pay = Math.max(0, base) * (Number(rule.percent) || 0) / 100 + (Number(rule.fixed_per_visit) || 0);
  return { base, pay, cost: pay * mult, noRule: false };
}

module.exports = { pickRule, doctorPay, ruleRank };
