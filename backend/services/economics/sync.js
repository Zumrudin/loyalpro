'use strict';
// Ночной проход экономики процедур: каталог товаров → техкарты → сверка товарных
// транзакций → обучение привязок техкарт → пересчёт «последней закупки».
// Квота YClients минутная и общая с Милой/«Заботой»: ≈33 запроса на салон,
// крон 5 5 * * * мск (после сверки записей 35 4 и чистки 40 4). Каждый шаг в
// своём try/catch — ошибка одного не останавливает остальные. Прогон идемпотентен.
const { ycGet } = require('../yclients');
const { withRateLimitRetry } = require('../yclients-retry');
const store = require('./store');
const { createLogger } = require('../../logger');
const logger = createLogger('EconomicsSync');

const PAGE = 100;
const MAX_GOODS_PAGES = 50;         // 5 000 товаров — на порядок больше 467 у PERI
const PAGE_PAUSE_MS = 400;
const RETRY = { retries: 2, delayMs: 60_000 };
const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function parseCatalogGood(g) {
  const id = num(g && (g.good_id !== undefined ? g.good_id : g.id));
  if (!id) return null;
  return {
    good_id: id,
    title: typeof g.title === 'string' ? g.title.slice(0, 500) : '',
    unit: typeof g.unit_short_title === 'string' ? g.unit_short_title.slice(0, 50) : null,
    service_unit: typeof g.service_unit_short_title === 'string' ? g.service_unit_short_title.slice(0, 50) : null,
    unit_equals: num(g.unit_equals),
    actual_cost: num(g.actual_cost),
    unit_actual_cost: num(g.unit_actual_cost),
    stock: (Array.isArray(g.actual_amounts) ? g.actual_amounts : [])
      .map(a => ({ storage_id: num(a.storage_id), amount: num(a.amount) })).filter(a => a.storage_id),
  };
}

/** GET /goods/{cid}?count=100&page=N до пустой страницы (БЕЗ category_id — иначе не весь каталог). */
async function syncGoodsCatalog(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const cid = salon.yclients_company_id;
  let pages = 0, goods = 0;
  for (let page = 1; page <= MAX_GOODS_PAGES; page++) {
    const chunk = await withRateLimitRetry(() => ycGet(salon, `/goods/${cid}`, { count: PAGE, page }), RETRY);
    pages++;
    if (!Array.isArray(chunk) || !chunk.length) return { pages, goods };
    for (const g of chunk) {
      const row = parseCatalogGood(g);
      if (!row) continue;
      await store.upsertCatalogGood(salon.id, row);
      goods++;
    }
    await sleep(PAGE_PAUSE_MS);
  }
  logger.warn(`salon=${salon.id}: каталог товаров упёрся в кап ${MAX_GOODS_PAGES} страниц`);
  return { pages, goods };
}

module.exports = { syncGoodsCatalog, parseCatalogGood, MAX_GOODS_PAGES, PAGE, RETRY, PAGE_PAUSE_MS, defaultSleep, num };
