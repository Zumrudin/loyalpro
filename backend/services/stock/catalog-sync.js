'use strict';
// Каталог склада: склады YClients, единицы, дерево категорий, вебхук `good`, локальные товары.
// В YClients только читаем (GET). Локальные товары — строки каталога с yclients_good_id NULL, source 'loyalpro'.
// ГОТЧА: у локального товара unit_id/service_unit_id — id из stock_units, у товара YClients — id единицы YClients; различать по source.
const { ycGet } = require('../yclients');
const { withRateLimitRetry } = require('../yclients-retry');
const { parseCatalogGood, num } = require('../economics/sync');
const { normTitle } = require('../economics/tech-cards');
const econStore = require('../economics/store');
const store = require('./store');
const { db } = require('../../db');
const { StockError, fail } = require('./model');
const { createLogger } = require('../../logger');
const logger = createLogger('StockCatalog');

const MAX_DEPTH = 4;
const MAX_CATEGORY_REQUESTS = 200;
const CATEGORY_PAUSE_MS = 400;
const CATEGORY_THROTTLE_MS = 30 * 60 * 1000;
const RETRY = { retries: 2, delayMs: 60_000 };
const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseStorage(s) {
  const id = num(s && s.id);
  if (!id) return null;
  return { ycStorageId: id, title: typeof s.title === 'string' ? s.title.slice(0, 200) : '', forService: Number(s.for_service) === 1 || s.for_service === true,
    forSale: Number(s.for_sale) === 1 || s.for_sale === true, comment: typeof s.comment === 'string' && s.comment ? s.comment.slice(0, 2000) : null, weight: num(s.weight) };
}

/** Корни + карта детей → плоский список с путями от корня. Глубина ≤ MAX_DEPTH, цикл обрывается. */
function flattenCategoryTree(roots, childrenById) {
  const out = [];
  const walk = (node, parentId, path) => {
    const id = Number(node.id);
    if (path.some(p => p.id === id)) return;           // цикл
    const here = path.concat([{ id, title: String(node.title || '') }]);
    if (here.length > MAX_DEPTH) return;
    out.push({ id, title: String(node.title || ''), parentId, path: here });
    for (const k of (childrenById && childrenById[id]) || []) walk(k, id, here);
  };
  for (const r of roots || []) walk(r, null, []);
  return out;
}

async function syncStorages(salon) {
  const cid = salon.yclients_company_id;
  const rows = await withRateLimitRetry(() => ycGet(salon, `/storages/${cid}`), RETRY);
  const parsed = (Array.isArray(rows) ? rows : []).map(parseStorage).filter(Boolean);
  if (!parsed.length) { logger.warn(`salon=${salon.id}: YClients не отдал складов — деактивацию пропускаем`); return { storages: 0 }; }
  for (const s of parsed) await store.upsertStorage(salon.id, s);
  await store.deactivateMissingStorages(salon.id, parsed.map(s => s.ycStorageId));
  return { storages: parsed.length };
}

async function syncCategories(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const settings = await store.getSettings(salon.id);
  const last = settings && settings.categories_synced_at ? new Date(settings.categories_synced_at).getTime() : 0;
  if (!opts.force && last && Date.now() - last < CATEGORY_THROTTLE_MS) return { skipped: 'throttled' };
  const cid = salon.yclients_company_id;
  const childrenById = {}; const roots = []; const seen = new Set(); const queue = [0]; let requests = 0;
  while (queue.length && requests < MAX_CATEGORY_REQUESTS) {
    const parent = queue.shift();
    const items = await withRateLimitRetry(() => ycGet(salon, `/goods_categories/${cid}/${parent}`), RETRY);
    requests++;
    for (const it of Array.isArray(items) ? items : []) {
      const id = num(it && it.id); if (!id || seen.has(id)) continue;
      seen.add(id);
      const node = { id, title: typeof it.title === 'string' ? it.title : '' };
      if (parent === 0) roots.push(node); else (childrenById[parent] = childrenById[parent] || []).push(node);
      queue.push(id);
    }
    if (queue.length) await sleep(CATEGORY_PAUSE_MS);
  }
  if (queue.length) logger.warn(`salon=${salon.id}: дерево категорий упёрлось в кап ${MAX_CATEGORY_REQUESTS} запросов`);
  const flat = flattenCategoryTree(roots, childrenById);
  for (const n of flat) await store.updateCatalogPaths(salon.id, n.id, n.path, n.parentId);
  await store.touchCategoriesSynced(salon.id);
  return { categories: flat.length, requests, truncated: queue.length > 0 };
}

/** Единицы из транзакций ({id,title,short_title}) и товаров (unit_id/unit_short_title | unit …). */
function unitsFromRows({ txnUnits = [], goods = [] } = {}) {
  const map = new Map();
  const add = (id, title, short) => {
    const n = num(id); const sh = typeof short === 'string' ? short.trim() : '';
    if (!n || !sh || map.has(n)) return;
    map.set(n, { ycUnitId: n, title: (typeof title === 'string' && title.trim()) || sh, shortTitle: sh });
  };
  for (const u of txnUnits) if (u && typeof u === 'object') add(u.id, u.title, u.short_title);
  for (const g of goods) {
    if (!g) continue;
    add(g.unit_id, g.unit_title || g.unit_short_title || g.unit, g.unit_short_title || g.unit);
    add(g.service_unit_id, g.service_unit_title || g.service_unit_short_title || g.service_unit, g.service_unit_short_title || g.service_unit);
  }
  return [...map.values()];
}

async function collectUnits(salonId) {
  const [txn, goods] = await Promise.all([store.txnUnitRows(salonId), store.goodUnitsRows(salonId)]);
  const list = unitsFromRows({ txnUnits: txn.map(r => r.unit), goods });
  let saved = 0;
  for (const u of list) {
    try { await store.upsertUnit(salonId, u); saved++; } catch (e) { logger.warn(`salon=${salonId}: единица ${u.ycUnitId} не сохранена: ${e.message}`); }
  }
  return { units: saved };
}

/** Вебхук resource='good'. delete — не удаление, а stock_active=false. */
async function handleGoodEvent(salon, payload) {
  if (!payload || payload.resource !== 'good') return { handled: false };
  const data = payload.data || {};
  const status = payload.status;
  if (status === 'delete') {
    const id = num(data.good_id !== undefined ? data.good_id : data.id);
    if (!id) return { handled: false };
    await store.setGoodActiveByYcId(salon.id, id, false);
    return { handled: true, status };
  }
  // Частичный payload (без title/unit_id) обнулил бы поля каталога через UPSERT — такой пропускаем, полную карточку принесёт ночной syncGoodsCatalog.
  if (data.title === undefined || data.unit_id === undefined) { logger.warn(`salon=${salon.id}: вебхук good ${data.good_id ?? data.id} без полной карточки — пропущен`); return { handled: false, partial: true }; }
  const row = parseCatalogGood(data);
  if (!row) return { handled: false };
  await econStore.upsertCatalogGood(salon.id, row);
  return { handled: true, status };
}

// ── Локальные товары ──
const optNonNeg = (v) => { if (v === null || v === undefined || v === '') return null; const n = num(v); return n !== null && n >= 0 ? n : NaN; };
const optStr = (v, max) => (v === null || v === undefined || v === '' ? null : (typeof v === 'string' && v.length <= max ? v : NaN));

/** Общий разбор полей формы; partial — проверять только присланные ключи. */
function parseFields(b, units, partial) {
  const errors = []; const v = {}; const has = (k) => !partial || Object.prototype.hasOwnProperty.call(b, k);
  if (has('title')) {
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 500) errors.push('Название: от 1 до 500 символов.'); else v.title = b.title.trim();
  }
  if (has('localCategory')) { const s = optStr(b.localCategory, 200); if (Number.isNaN(s)) errors.push('Категория: не длиннее 200 символов.'); else v.localCategory = s; }
  const unitIds = new Set((units || []).map(u => Number(u.id)));
  if (has('unitId')) { const n = num(b.unitId); if (!n || !unitIds.has(n)) errors.push('Единица продажи не найдена.'); else v.unitId = n; }
  if (has('serviceUnitId')) {
    if (b.serviceUnitId === null || b.serviceUnitId === undefined || b.serviceUnitId === '') v.serviceUnitId = null;
    else { const n = num(b.serviceUnitId); if (!n || !unitIds.has(n)) errors.push('Единица списания не найдена.'); else v.serviceUnitId = n; }
  }
  if (has('unitEquals')) {
    if (b.unitEquals === undefined || b.unitEquals === null || b.unitEquals === '') v.unitEquals = 1;
    else { const n = num(b.unitEquals); if (!(n >= 1)) errors.push('В упаковке — число не меньше 1.'); else v.unitEquals = n; }
  }
  for (const [k, label] of [['salePrice', 'Цена продажи'], ['actualCost', 'Себестоимость'], ['criticalAmount', 'Критический остаток']]) {
    if (has(k)) { const n = optNonNeg(b[k]); if (Number.isNaN(n)) errors.push(`${label}: число не меньше нуля.`); else v[k] = n; }
  }
  if (has('barcode')) { const s = optStr(b.barcode, 64); if (Number.isNaN(s)) errors.push('Штрихкод: не длиннее 64 символов.'); else v.barcode = s; }
  if (has('note')) { const s = optStr(b.note, 1000); if (Number.isNaN(s)) errors.push('Заметка: не длиннее 1000 символов.'); else v.note = s; }
  if (b && 'stockActive' in b) { if (typeof b.stockActive !== 'boolean') errors.push('Активность: true или false.'); else v.stockActive = b.stockActive; }
  return { errors, v };
}

function parseLocalGoodBody(b, units) {
  const { errors, v } = parseFields(b || {}, units, false);
  if (errors.length) fail(errors[0], 400, 'validation', { errors });
  return { unitEquals: 1, serviceUnitId: null, salePrice: null, actualCost: null, criticalAmount: null, barcode: null, note: null, localCategory: null, ...v };
}

function similarTitles(title, existing) {
  const t = normTitle(title); if (t.length < 3) return [];
  return (existing || []).filter(g => { const e = normTitle(g.title); return e.length >= 3 && (e === t || (Math.min(e.length, t.length) >= 4 && (e.startsWith(t) || t.startsWith(e)))); });
}

async function createLocalGood(salonId, userId, body) {
  const units = await store.listUnits(salonId);
  const p = parseLocalGoodBody(body, units);
  const unit = units.find(u => Number(u.id) === p.unitId);
  const sUnit = p.serviceUnitId ? units.find(u => Number(u.id) === p.serviceUnitId) : unit;
  // Себестоимость локального товара живёт в самом каталоге: goods_price_overrides ключуется по id YClients, которого тут нет.
  const unitCost = p.actualCost !== null && p.unitEquals > 0 ? Math.round(p.actualCost / p.unitEquals * 10000) / 10000 : null;
  const row = await db.oneOrNone(`
    INSERT INTO yclients_goods_catalog (salon_id, yclients_good_id, source, title, local_category, unit, service_unit, unit_id, service_unit_id,
      unit_equals, local_sale_price, critical_amount, barcode, local_note, actual_cost, unit_actual_cost, stock_active, is_archived, last_seen_at, updated_at)
    VALUES ($1, NULL, 'loyalpro', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE, TRUE, NOW(), NOW())
    RETURNING id`, [salonId, p.title, p.localCategory, unit.short_title, sUnit.short_title, p.unitId, p.serviceUnitId || p.unitId,
    p.unitEquals, p.salePrice, p.criticalAmount, p.barcode, p.note, p.actualCost, unitCost]);
  logger.info(`salon=${salonId} user=${userId || '-'}: локальный товар #${row.id}`);
  return store.goodById(salonId, row.id);
}

async function updateGood(salonId, id, body) {
  const good = await store.goodById(salonId, id);
  if (!good) fail('Товар не найден.', 404, 'not_found');
  const b = body || {};
  const units = await store.listUnits(salonId);
  const { errors, v } = parseFields(b, units, true);
  if (errors.length) fail(errors[0], 400, 'validation', { errors });
  const sets = []; const params = [salonId, id];
  const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (good.source === 'yclients') {
    // critical_amount у товара YClients перезаписывает ночной syncGoodsCatalog — править его здесь бессмысленно (ведётся в YClients).
    if ('salePrice' in v) put('local_sale_price', v.salePrice);
    if ('note' in v) put('local_note', v.note);
    if ('stockActive' in v) put('stock_active', v.stockActive);
  } else {
    if ('title' in v) put('title', v.title);
    if ('localCategory' in v) put('local_category', v.localCategory);
    if ('unitId' in v) { put('unit_id', v.unitId); put('unit', units.find(u => Number(u.id) === v.unitId).short_title); }
    if ('serviceUnitId' in v) {
      const su = v.serviceUnitId ? units.find(u => Number(u.id) === v.serviceUnitId) : units.find(u => Number(u.id) === (v.unitId || Number(good.unit_id)));
      put('service_unit_id', v.serviceUnitId || v.unitId || good.unit_id); if (su) put('service_unit', su.short_title);
    }
    if ('unitEquals' in v) put('unit_equals', v.unitEquals);
    if ('salePrice' in v) put('local_sale_price', v.salePrice);
    if ('actualCost' in v) {
      put('actual_cost', v.actualCost);
      const eq = 'unitEquals' in v ? v.unitEquals : Number(good.unit_equals) || 1;
      put('unit_actual_cost', v.actualCost === null ? null : Math.round(v.actualCost / eq * 10000) / 10000);
    }
    if ('criticalAmount' in v) put('critical_amount', v.criticalAmount);
    if ('barcode' in v) put('barcode', v.barcode);
    if ('note' in v) put('local_note', v.note);
    if ('stockActive' in v) put('stock_active', v.stockActive);
  }
  if (!sets.length) return good;
  await db.query(`UPDATE yclients_goods_catalog SET ${sets.join(', ')}, updated_at = NOW() WHERE salon_id = $1 AND id = $2`, params);
  return store.goodById(salonId, id);
}

module.exports = { parseStorage, flattenCategoryTree, syncStorages, syncCategories, unitsFromRows, collectUnits, handleGoodEvent,
  parseLocalGoodBody, similarTitles, createLocalGood, updateGood, StockError, CATEGORY_THROTTLE_MS };
