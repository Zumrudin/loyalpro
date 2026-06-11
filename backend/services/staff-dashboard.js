// ── Personal Staff Dashboard — pure helpers ────────────────────────
'use strict';

// Принимает строки из revenue_operations: [{category, total}],
// возвращает {services, goods, abonement, total} с float-значениями и нулями
// для отсутствующих категорий. Категории кроме services/goods/abonement игнорируем
// (для специалиста релевантны только эти три — сертификаты/пополнения счёта
// продаются на ресепшене и не привязаны к мастеру).
function aggregateRevenueByCategory(rows) {
  const out = { services: 0, goods: 0, abonement: 0, total: 0 };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r && (r.category in out) && r.category !== 'total') {
      out[r.category] = parseFloat(r.total) || 0;
    }
  }
  out.total = out.services + out.goods + out.abonement;
  return out;
}

// Средний чек: округление до целого, ноль если count=0 (защита от деления на 0).
function computeAvgCheck(count, sum) {
  const c = parseInt(count) || 0;
  const s = parseFloat(sum) || 0;
  return c > 0 ? Math.round(s / c) : 0;
}

// Границы сравнительных периодов относительно даты `to` (YYYY-MM-DD):
// весь предыдущий календарный месяц + эквивалентный отрезок (с 1-го по то же
// число; если в прошлом месяце дней меньше — по его конец). Чистая UTC-арифметика
// по строке даты — таймзона сервера не влияет.
function prevMonthRanges(to) {
  const t = new Date(to + 'T00:00:00Z');
  const prevLast = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
  const prevFirst = new Date(Date.UTC(prevLast.getUTCFullYear(), prevLast.getUTCMonth(), 1));
  const day = Math.min(t.getUTCDate(), prevLast.getUTCDate());
  const windowTo = new Date(Date.UTC(prevLast.getUTCFullYear(), prevLast.getUTCMonth(), day));
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    monthFrom: iso(prevFirst), monthTo: iso(prevLast),
    windowFrom: iso(prevFirst), windowTo: iso(windowTo),
  };
}

module.exports = { aggregateRevenueByCategory, computeAvgCheck, prevMonthRanges };
