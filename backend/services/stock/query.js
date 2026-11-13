'use strict';
// Чистые разборщики query-строки API склада (без express/БД).
const { KINDS, ORIGINS, StockError } = require('./model');
const { isCalendarDate } = require('../../utils/period');

const MAX_PERIOD_DAYS = 731;
const STATUSES = ['draft', 'posted', 'cancelled'];
const posInt = v => { if (typeof v !== 'string' || !/^\d{1,12}$/.test(v)) return null; const n = Number(v); return n > 0 ? n : null; };
const flag = v => v === '1';

function parseGoodsQuery(q = {}) {
  q = q || {};
  let category = null;
  if (typeof q.category === 'string' && q.category !== '' && q.category.length <= 200) category = posInt(q.category) ?? q.category;
  return {
    search: typeof q.search === 'string' ? q.search.slice(0, 100) : '',
    category,
    storage: posInt(q.storage),
    onlyCritical: flag(q.only_critical),
    onlyNegative: flag(q.only_negative),
    active: q.active === '1' ? true : q.active === '0' ? false : null,
    source: q.source === 'yclients' || q.source === 'loyalpro' ? q.source : null,
  };
}

// Период: обе границы — календарные даты, не длиннее 731 дня; иначе 400. Перевёрнутый меняется местами.
function parsePeriod(from, to, required) {
  if (from == null && to == null && !required) return { from: null, to: null };
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new StockError('Период: укажите from и to в формате ГГГГ-ММ-ДД.', 400, 'bad_period');
  if (from > to) [from, to] = [to, from];
  const days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000 + 1;
  if (days > MAX_PERIOD_DAYS) throw new StockError(`Период не длиннее ${MAX_PERIOD_DAYS} дней.`, 400, 'bad_period');
  return { from, to };
}

function parseDocsQuery(q = {}) {
  q = q || {};
  const { from, to } = parsePeriod(q.from, q.to, false);
  const limit = posInt(q.limit);
  return {
    kind: KINDS.includes(q.kind) ? q.kind : null,
    status: STATUSES.includes(q.status) ? q.status : null,
    origin: ORIGINS.includes(q.origin) ? q.origin : null,
    from, to,
    client: posInt(q.client), record: posInt(q.record), storage: posInt(q.storage),
    page: posInt(q.page) || 1,
    limit: limit ? Math.min(limit, 200) : 50,
  };
}

function parseTurnoverQuery(q = {}) {
  q = q || {};
  const { from, to } = parsePeriod(q.from, q.to, true);
  const g = parseGoodsQuery({ category: q.category });
  return { from, to, storage: posInt(q.storage), category: g.category };
}

module.exports = { parseGoodsQuery, parseDocsQuery, parseTurnoverQuery, MAX_PERIOD_DAYS };
