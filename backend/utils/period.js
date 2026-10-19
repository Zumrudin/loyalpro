'use strict';
// Общий разбор периода отчётов: дашборд (routes/api.js) и «Экономика»
// (routes/economics.js). До 19.10.2026 это были две копии, и они разошлись:
// у дашборда был 'day', у экономики 'quarter', '0' давал 1 день и 30 дней.
// Набор значений — объединение обоих, для значений дашборда поведение прежнее.
//
// БЕЗОПАСНОСТЬ: огромный ?period= (1e17) давал Invalid Date → toISOString()
// бросал RangeError; в «Экономике» разбор шёл до try асинхронного хендлера
// Express 4 → unhandled rejection → падение процесса. Теперь мусор не бросает
// ничего, кроме PeriodError (code 'BAD_PERIOD'), который вызывающий отдаёт 400.
//
// Даты from/to — только календарные YYYY-MM-DD (2026-02-30 не принимается:
// pg уронил бы запрос), иначе разбор идёт по period. Арифметика — UTC над
// московской датой «сегодня».

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Глубже ~270 лет назад period не бывает; выше этой границы Date ломается.
const MAX_LOOKBACK_DAYS = 100000;

class PeriodError extends Error {
  constructor(message) { super(message); this.name = 'PeriodError'; this.code = 'BAD_PERIOD'; }
}

function isCalendarDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayMsk(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  if (Number.isNaN(d.getTime())) throw new PeriodError('Некорректный период');
  return d.toISOString().slice(0, 10);
}

/**
 * query: { from, to, period }. period: today|day|week|month|quarter|N (дней назад, по умолчанию 30).
 * Возвращает { from, to } включительно (московские даты) или бросает PeriodError.
 */
function resolvePeriod(query, { now } = {}) {
  const q = query || {};
  const today = todayMsk(now || new Date());
  let { from, to } = q;
  if (isCalendarDate(from) && isCalendarDate(to)) {
    if (from > to) [from, to] = [to, from];
    return { from, to };
  }
  const preset = String(q.period || '').toLowerCase();
  if (preset === 'today' || preset === 'day') return { from: today, to: today };
  if (preset === 'week') {
    const dow = new Date(today + 'T00:00:00Z').getUTCDay();
    return { from: addDays(today, -(dow === 0 ? 6 : dow - 1)), to: today };
  }
  if (preset === 'month') return { from: today.slice(0, 8) + '01', to: today };
  if (preset === 'quarter') {
    const m = Number(today.slice(5, 7));
    const qm = String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0');
    return { from: `${today.slice(0, 4)}-${qm}-01`, to: today };
  }
  const parsed = Number.parseInt(q.period || '30', 10);
  const days = Number.isFinite(parsed) ? Math.max(1, parsed) : 30;
  if (days > MAX_LOOKBACK_DAYS) throw new PeriodError('Период слишком длинный');
  return { from: addDays(today, -(days - 1)), to: today };
}

module.exports = { resolvePeriod, isCalendarDate, todayMsk, PeriodError, MAX_LOOKBACK_DAYS };
