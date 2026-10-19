'use strict';
// Распределения (§3.1, 3.6 спеки). Чистые функции, даты — строки 'YYYY-MM-DD'.
const r2 = (x) => Math.round(x * 100) / 100;

/** total по весам; копейки сходятся: последняя доля — остаток. Нулевые веса → поровну. */
function splitByWeights(total, weights) {
  const n = weights.length;
  if (!n) return [];
  const w = weights.map(x => Math.max(0, Number(x) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const eff = sum > 0 ? w : w.map(() => 1);
  const effSum = sum > 0 ? sum : n;
  const out = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) { const v = r2(total * eff[i] / effSum); out.push(v); acc += v; }
  out.push(r2(total - acc));
  return out;
}

/** Минуты записи между услугами пропорционально длительности в каталоге (сек); нет — поровну. */
function splitMinutes(seanceLengthSec, durationsSec) {
  const minutes = (Number(seanceLengthSec) || 0) / 60;
  const ds = (durationsSec || []).map(d => Number(d) || 0);
  return splitByWeights(minutes, ds.some(d => d > 0) ? ds : ds.map(() => 1));
}

function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** [{month:'YYYY-MM', days, share}] — доли дней каждого месяца, попавших в период (границы включительно). */
function monthShares(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const ym = cur.slice(0, 7);
    const dim = daysInMonth(ym);
    const monthEnd = `${ym}-${String(dim).padStart(2, '0')}`;
    const end = monthEnd < to ? monthEnd : to;
    const days = Math.round((Date.parse(end) - Date.parse(cur)) / 86400000) + 1;
    out.push({ month: ym, days, share: days / dim });
    cur = addDays(monthEnd, 1);
  }
  return out;
}

/** Σ amount_month × доля месяца по строкам бюджета, действующим в этом месяце. */
function periodFixedCosts(rows, from, to) {
  const shares = monthShares(from, to);
  let total = 0; const byCategory = {}; const byMonth = {};
  for (const { month, share } of shares) {
    for (const fc of rows || []) {
      const mf = String(fc.month_from || '').slice(0, 7);
      const mt = fc.month_to ? String(fc.month_to).slice(0, 7) : null;
      if (!mf || mf > month || (mt && mt < month)) continue;
      const v = (Number(fc.amount_month) || 0) * share;
      total += v;
      byCategory[fc.category] = (byCategory[fc.category] || 0) + v;
      byMonth[month] = (byMonth[month] || 0) + v;
    }
  }
  return { total, byCategory, byMonth, months: shares };
}

function equipmentMonthly(eq) {
  const price = Number(eq.purchase_price) || 0;
  const residual = Math.min(100, Math.max(0, Number(eq.residual_pct) || 0));
  const life = Math.max(1, Number(eq.useful_life_months) || 60);
  const depreciation = r2(price * (1 - residual / 100) / life);
  const maintenance = r2(Number(eq.maintenance_monthly) || 0);
  return { depreciation, maintenance, total: r2(depreciation + maintenance) };
}

/** Стоимость аппарата за период: амортизация в пределах срока службы + ТО; неактивный → 0. */
function equipmentPeriodCost(eq, from, to) {
  if (eq.is_active === false) return 0;
  const m = equipmentMonthly(eq);
  const startYm = eq.purchase_date ? String(eq.purchase_date).slice(0, 7) : null;
  const life = Math.max(1, Number(eq.useful_life_months) || 60);
  let endYm = null;
  if (startYm) { const [y, mo] = startYm.split('-').map(Number); const e = new Date(Date.UTC(y, mo - 1 + life - 1, 1)); endYm = e.toISOString().slice(0, 7); }
  let total = 0;
  for (const { month, share } of monthShares(from, to)) {
    if (startYm && month < startYm) continue;
    const dep = (!endYm || month <= endYm) ? m.depreciation : 0;
    total += (dep + m.maintenance) * share;
  }
  return r2(total);
}

function rate(driver, sum, rows) {
  if (!rows || !rows.length) return 0;
  if (driver === 'visits') return sum / rows.length;
  const minutes = rows.reduce((a, r) => a + (Number(r.minutes) || 0), 0);
  return minutes > 0 ? sum / minutes : 0;
}

/** Массив сумм параллельно rows; filterServiceIds (Set) — только строки этих услуг (аппарат). */
function allocate(rows, driver, sum, filterServiceIds = null) {
  const idx = rows.map((r, i) => i).filter(i => !filterServiceIds || filterServiceIds.has(Number(rows[i].service_yc_id)));
  const sub = idx.map(i => rows[i]);
  const weights = driver === 'visits' ? sub.map(() => 1) : sub.map(r => Number(r.minutes) || 0);
  const parts = splitByWeights(sum, weights);
  const out = rows.map(() => 0);
  idx.forEach((i, k) => { out[i] = parts[k]; });
  return out;
}

module.exports = { splitByWeights, splitMinutes, monthShares, periodFixedCosts, equipmentMonthly, equipmentPeriodCost, rate, allocate, daysInMonth, addDays, r2 };
