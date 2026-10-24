'use strict';
// Строки акта: из услуг записи YClients и после правок администратора.
// Сумма строки — manual_cost: цена после скидки, но ДО оплаты бонусами. Бонусы —
// способ оплаты и стоимость услуги в акте не уменьшают, а YClients иногда вычитает
// их прямо из cost (данные PERI 24.10.2026: first_cost 17500, discount 10 %,
// manual_cost 15750, cost 7737.61). Нет manual_cost — first_cost × (1 − discount/100);
// discount в YClients — ПРОЦЕНТ (10 % от 60000 → cost 54000).
const MAX_LINES = 50;
const CONTROL_RE = /[\u0000-\u001F\u007F‪-‮⁦-⁩]/g;

const round2 = (n) => Math.round(Number(n) * 100) / 100;
// Только число или строка: Number([5]) === 5 — массив не должен проходить как число.
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.replace(/[\s ]/g, '').replace(',', '.'));
  return NaN;
}

/** Строки по умолчанию из records.services. */
function linesFromRecord(services) {
  return (Array.isArray(services) ? services : []).map((s) => {
    const qty = num(s.amount) > 0 ? num(s.amount) : 1;
    const first = num(s.first_cost);
    const full = Number.isFinite(first) ? first : (Number.isFinite(num(s.cost_per_unit)) ? num(s.cost_per_unit) : 0) * qty;
    const manual = num(s.manual_cost);
    const disc = Number.isFinite(num(s.discount)) ? num(s.discount) : 0;
    const sum = Number.isFinite(manual) ? manual : full * (1 - disc / 100);
    return {
      service_id: Number.isInteger(num(s.id)) && num(s.id) > 0 ? num(s.id) : null,
      title: String(s.title || 'Услуга').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 300),
      qty,
      price: round2(full / qty),
      sum: round2(Math.max(0, sum)),
    };
  });
}

/** Проверка строк, присланных администратором. @returns {{value}|{error}} */
function normalizeLines(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_LINES) return { error: `Строки акта — список из 1–${MAX_LINES}` };
  const out = [];
  for (const [i, l] of input.entries()) {
    const n = i + 1;
    if (!l || typeof l !== 'object') return { error: `Строка ${n}: неверный формат` };
    const title = String(l.title || '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 300) return { error: `Строка ${n}: название — 1–300 символов` };
    const qty = num(l.qty), price = num(l.price), sum = num(l.sum);
    if (!(qty > 0 && qty <= 1000)) return { error: `Строка ${n}: количество — больше 0 и не больше 1000` };
    if (!(price >= 0 && price <= 10000000)) return { error: `Строка ${n}: цена — от 0 до 10 000 000` };
    if (!(sum >= 0 && sum <= 10000000)) return { error: `Строка ${n}: сумма — от 0 до 10 000 000` };
    const sid = l.service_id === null || l.service_id === undefined || l.service_id === '' ? null : num(l.service_id);
    if (sid !== null && !(Number.isInteger(sid) && sid > 0)) return { error: `Строка ${n}: неверный id услуги` };
    out.push({ service_id: sid, title, qty: Math.round(qty * 1000) / 1000, price: round2(price), sum: round2(sum) });
  }
  return { value: out };
}

/** Номера строк, скидка строки (qty × price − sum, не меньше 0) и итог. */
function actTotals(lines) {
  const rows = (lines || []).map((l, i) => ({ ...l, n: i + 1, discount: round2(Math.max(0, l.qty * l.price - l.sum)) }));
  return {
    lines: rows,
    total_sum: round2(rows.reduce((a, l) => a + l.sum, 0)),
    total_discount: round2(rows.reduce((a, l) => a + l.discount, 0)),
  };
}

/** Врач и должность из records.staff (объект YClients). */
function doctorOf(staff) {
  const s = staff && typeof staff === 'object' && !Array.isArray(staff) ? staff : {};
  return {
    name: String(s.name || '').trim(),
    position: String((s.position && s.position.title) || s.specialization || '').trim(),
  };
}

module.exports = { MAX_LINES, linesFromRecord, normalizeLines, actTotals, doctorOf };
