'use strict';
// Схемы оплаты врача (спека docs/superpowers/specs/2026-10-19-economics-pay-schemes-design.md, §3).
// Схема: { id, lines: [{ percent, base, payroll_multiplier|null, fixed_per_visit, categories:[], services:[] }] }.
// Назначение: { id, staff_yc_id, scheme_id, valid_from, valid_to } (строки 'YYYY-MM-DD', NULL = открыто).
// Приоритет линии: услуга названа прямо → её категория → линия без целей («остальные
// услуги») → null (нет оплаты, флаг no_pay_rule в calc). Чистый модуль, без БД.
function isNull(v) { return v === null || v === undefined; }
function day(v) { return v ? String(v).slice(0, 10) : null; }
function sameId(a, b) { return !isNull(a) && !isNull(b) && String(a) === String(b); }
function hasId(list, id) { return !isNull(id) && Array.isArray(list) && list.some(x => String(x) === String(id)); }
function isFallbackLine(line) { return !(line && Array.isArray(line.services) && line.services.length) && !(line && Array.isArray(line.categories) && line.categories.length); }

function activeOn(a, d) {
  return (!day(a.valid_from) || !d || day(a.valid_from) <= d) && (!day(a.valid_to) || !d || day(a.valid_to) >= d);
}

/** Назначение сотрудника, действующее на дату: позднейшее valid_from, затем больший id. */
function pickAssignment(assignments, staffId, date) {
  const d = day(date);
  const cands = (assignments || []).filter(a => a && sameId(a.staff_yc_id, staffId) && activeOn(a, d));
  if (!cands.length) return null;
  cands.sort((a, b) => String(day(b.valid_from) || '').localeCompare(String(day(a.valid_from) || '')) || Number(b.id || 0) - Number(a.id || 0));
  return cands[0];
}

/** Индекс линии схемы для услуги (услуга → категория → остальные) или -1. */
function pickLineIdx(lines, { serviceId, categoryId }) {
  const ls = Array.isArray(lines) ? lines : [];
  let i = ls.findIndex(l => l && hasId(l.services, serviceId)); if (i >= 0) return i;
  i = ls.findIndex(l => l && hasId(l.categories, categoryId)); if (i >= 0) return i;
  return ls.findIndex(l => l && isFallbackLine(l));
}

/** Поиск схемы по id: ключи сравниваются строкой — bigint из pg приходит строкой,
 *  а Map от вызывающего может быть с числовыми ключами (и наоборот). */
function findScheme(schemes, id) {
  if (isNull(id) || !schemes) return null;
  const k = String(id);
  if (schemes instanceof Map) {
    if (schemes.has(id)) return schemes.get(id);
    for (const [key, s] of schemes) if (String(key) === k) return s;
    return null;
  }
  return (Array.isArray(schemes) ? schemes : []).find(s => s && String(s.id) === k) || null;
}

/** pay: { assignments: [...], schemes: Map(id→scheme) | [...] }. → { schemeId, lineIdx, line, assignmentId } | null */
function resolvePay(pay, { staffId, serviceId, categoryId, date }) {
  if (!pay) return null;
  const a = pickAssignment(pay.assignments, staffId, date);
  if (!a) return null;
  const scheme = findScheme(pay.schemes, a.scheme_id);
  if (!scheme) return null;
  const lineIdx = pickLineIdx(scheme.lines, { serviceId, categoryId });
  if (lineIdx < 0) return null;
  return { schemeId: Number(scheme.id), lineIdx, line: scheme.lines[lineIdx], assignmentId: a.id };
}

/** row: {price, revenue, materials_used}; line — линия схемы (fixed_per_visit уже поделён calc'ом);
 *  settings: {payroll_multiplier, pay_base_includes_bonuses}. Множитель: линия > салон > 1. */
function doctorPay(row, line, settings = {}) {
  if (!line) return { base: 0, pay: 0, cost: 0, noRule: true };
  const own = Number(line.payroll_multiplier), salon = Number(settings.payroll_multiplier);
  const mult = own > 0 ? own : (salon > 0 ? salon : 1);
  const start = settings.pay_base_includes_bonuses ? Number(row.price) || 0 : Number(row.revenue) || 0;
  const base = line.base === 'net_of_materials' ? start - (Number(row.materials_used) || 0) : start;
  const pay = Math.max(0, base) * (Number(line.percent) || 0) / 100 + (Number(line.fixed_per_visit) || 0);
  return { base, pay, cost: pay * mult, noRule: false };
}

/** Конфликты линий схемы: [{kind:'service'|'category'|'fallback', id, lines:[i, j]}]. Пусто — схема корректна.
 *  Повтор id внутри одной линии конфликтом не считается (парсер дедупит). */
function schemeLineConflicts(lines) {
  const out = []; const seen = { service: new Map(), category: new Map() }; const fallbacks = [];
  (Array.isArray(lines) ? lines : []).forEach((l, i) => {
    if (!l) return;
    for (const [kind, key] of [['service', 'services'], ['category', 'categories']]) {
      for (const id of (Array.isArray(l[key]) ? l[key] : [])) {
        const k = String(id);
        const first = seen[kind].get(k);
        if (first === undefined) seen[kind].set(k, i);
        else if (first !== i && !out.some(c => c.kind === kind && String(c.id) === k)) out.push({ kind, id: Number(id), lines: [first, i] });
      }
    }
    if (isFallbackLine(l)) fallbacks.push(i);
  });
  if (fallbacks.length > 1) out.push({ kind: 'fallback', id: null, lines: fallbacks.slice(0, 2) });
  return out;
}

function conflictText(c) {
  const [a, b] = c.lines.map(i => i + 1);
  if (c.kind === 'fallback') return `Линия «остальные услуги» может быть только одна (линии ${a} и ${b})`;
  return `${c.kind === 'service' ? 'Услуга' : 'Категория'} #${c.id} стоит в линиях ${a} и ${b} — оставьте её в одной`;
}

/** Назначения того же сотрудника, чей период пересекается с кандидатом (NULL — бесконечность); cand.id исключается. */
function assignmentsOverlap(existing, cand) {
  const from = day(cand.valid_from) || '0000-00-00', to = day(cand.valid_to) || '9999-12-31';
  return (existing || []).filter(a => a && sameId(a.staff_yc_id, cand.staff_yc_id) && !(!isNull(cand.id) && sameId(a.id, cand.id)))
    .filter(a => (day(a.valid_from) || '0000-00-00') <= to && (day(a.valid_to) || '9999-12-31') >= from);
}

module.exports = { resolvePay, pickAssignment, pickLineIdx, doctorPay, schemeLineConflicts, conflictText, assignmentsOverlap, isFallbackLine };
