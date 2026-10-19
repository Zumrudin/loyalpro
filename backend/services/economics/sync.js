'use strict';
// Ночной проход экономики процедур: каталог товаров → техкарты → сверка товарных
// транзакций → обучение привязок техкарт → пересчёт «последней закупки».
// Квота YClients минутная и общая с Милой/«Заботой»: ≈33 запроса на салон,
// крон 5 5 * * * мск (после сверки записей 35 4 и чистки 40 4). Каждый шаг в
// своём try/catch — ошибка одного не останавливает остальные. Прогон идемпотентен.
const { ycGet } = require('../yclients');
const { withRateLimitRetry } = require('../yclients-retry');
const store = require('./store');
const { parseTransaction } = require('./goods-events');
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

// ── Товарные транзакции: сверка (крон) и догон истории (скрипт) ─────────────
const RECONCILE_DAYS = 2;
const MAX_TXN_PAGES = 200;          // 20 000 транзакций за запрос — месяц у PERI ≈ 1 700

/** Московская дата 'YYYY-MM-DD' (со сдвигом в сутках). */
function mskDate(now = new Date(), shiftDays = 0) {
  const d = new Date(now.getTime() + shiftDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

/**
 * Постранично читает /storages/transactions с заданными params и апсертит.
 * Идёт до ПУСТОЙ страницы (count YClients не обязан соблюдать — тот же приём,
 * что у /goods). Строка, которую не разобрать или не записать, — skipped + WARN:
 * иначе одна битая строка в окне changed_after роняла бы сверку каждую ночь.
 */
async function pullTransactions(salon, params, source, sleep, dryRun = false) {
  const cid = salon.yclients_company_id;
  let pages = 0, upserted = 0, skipped = 0, receipts = 0;
  const receiptGoods = new Set();
  for (let page = 1; page <= MAX_TXN_PAGES; page++) {
    const chunk = await withRateLimitRetry(
      () => ycGet(salon, `/storages/transactions/${cid}`, { ...params, page, count: PAGE }), RETRY);
    pages++;
    if (!Array.isArray(chunk) || !chunk.length) break;
    for (const t of chunk) {
      const row = parseTransaction(t);
      if (!row) { skipped++; continue; }
      try {
        if (!dryRun) await store.upsertGoodsTransaction(salon.id, row, { status: 'update', source });
      } catch (e) {
        skipped++;
        logger.warn(`salon=${salon.id}: транзакция ${row.yclients_txn_id} не записана: ${e.message}`);
        continue;
      }
      upserted++;
      if (Number(row.type_id) === 3 && row.good_id) { receipts++; receiptGoods.add(row.good_id); }
    }
    if (page === MAX_TXN_PAGES) logger.warn(`salon=${salon.id}: транзакции упёрлись в кап ${MAX_TXN_PAGES} страниц (${JSON.stringify(params)})`);
    await sleep(PAGE_PAUSE_MS);
  }
  return { pages, upserted, skipped, receipts, receiptGoods };
}

/**
 * Крон: changed_after = начало суток (мск) сегодня − 2 дня (потерянные вебхуки,
 * правки задним числом). ГОТЧА, пойманная живым запросом 19.10.2026: голую дату
 * ('2026-10-17') YClients МОЛЧА ИГНОРИРУЕТ и отдаёт всю историю (даже '2030-01-01'
 * давал полную страницу) — фильтр по last_change_date работает только с временем
 * ('2026-10-17T00:00:00'). start_date/end_date догона голую дату понимают.
 */
async function reconcileGoodsTransactions(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const changedAfter = `${mskDate(opts.now || new Date(), -RECONCILE_DAYS)}T00:00:00`;
  const r = await pullTransactions(salon, { changed_after: changedAfter }, 'reconcile', sleep);
  for (const goodId of r.receiptGoods) {
    await Promise.resolve().then(() => store.refreshLastReceipt(salon.id, goodId))
      .catch(e => logger.warn(`last receipt good=${goodId}: ${e.message}`));
  }
  logger.info(`salon=${salon.id}: сверка транзакций changed_after=${changedAfter}: ${r.upserted} строк, ${r.skipped} пропущено`);
  return { pages: r.pages, upserted: r.upserted, skipped: r.skipped, receipts: r.receipts };
}

/** [[start,end], …] по календарным месяцам внутри [from, to] (включительно). */
function monthRanges(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const [y, m] = cur.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${cur.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
    out.push([cur, end < to ? end : to]);
    cur = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Разовый догон истории помесячно (start_date/end_date); только ручным скриптом.
 *  opts.dryRun — читать и разбирать, но в БД не писать (дефолт скрипта). */
async function backfillGoodsTransactions(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const from = opts.from;
  const to = opts.to || mskDate(new Date());
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to) || from > to) throw new Error('backfill: from/to в формате YYYY-MM-DD, from <= to');
  let months = 0, upserted = 0, skipped = 0;
  for (const [start, end] of monthRanges(from, to)) {
    const r = await pullTransactions(salon, { start_date: start, end_date: end }, 'backfill', sleep, !!opts.dryRun);
    months++; upserted += r.upserted; skipped += r.skipped;
    logger.info(`salon=${salon.id}: догон ${start}..${end}: ${r.upserted} строк`);
    if (opts.onMonth) opts.onMonth({ start, end, pages: r.pages, upserted: r.upserted, skipped: r.skipped, receipts: r.receipts });
  }
  if (!opts.dryRun) await store.refreshAllLastReceipts(salon.id);
  return { months, upserted, skipped };
}

module.exports = { syncGoodsCatalog, parseCatalogGood, MAX_GOODS_PAGES, PAGE, RETRY, PAGE_PAUSE_MS, defaultSleep, num,
  reconcileGoodsTransactions, backfillGoodsTransactions, monthRanges, mskDate, RECONCILE_DAYS, MAX_TXN_PAGES };
