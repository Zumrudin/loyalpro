'use strict';
// IO-слой экономики процедур. SQL экспортируется ради живого EXPLAIN
// (scripts/economics-explain.js) — ГОТЧА проекта: EXPLAIN с литералами не
// ловит вывод типов параметров. Загрузчики отчёта — ниже (задача 11).
const { db } = require('../../db');
const { receiptUnitPrice } = require('./price');
const { createLogger } = require('../../logger');
const logger = createLogger('EconomicsStore');

const TXN_COLS = [
  'document_id', 'type_id', 'type_title', 'good_id', 'good_title', 'storage_id', 'unit_title',
  'operation_unit_type', 'amount', 'cost_per_unit', 'cost', 'discount', 'record_id', 'service_id',
  'service_title', 'master_id', 'supplier_title', 'create_date', 'last_change_date', 'raw',
];

/**
 * Апсерт строки goods_transactions. status 'delete' ставит deleted_at (строка
 * остаётся — форензика), create/update снимают deleted_at (сверка вернула живую).
 * @param {number} salonId
 * @param {object} row — результат goods-events.parseTransaction
 * @param {{status:'create'|'update'|'delete', source:'webhook'|'reconcile'|'backfill', deletedAt?:string}} opts
 */
async function upsertGoodsTransaction(salonId, row, opts) {
  const { status, source } = opts;
  const deletedAt = status === 'delete' ? (opts.deletedAt || null) : null;
  const vals = TXN_COLS.map(c => (c === 'raw' ? JSON.stringify(row.raw || {}) : (row[c] === undefined ? null : row[c])));
  const params = [salonId, row.yclients_txn_id, ...vals, source, deletedAt];
  const colList = TXN_COLS.join(', ');
  const placeholders = TXN_COLS.map((c, i) => `$${i + 3}${c === 'raw' ? '::jsonb' : ''}`).join(', ');
  const nSrc = TXN_COLS.length + 3;
  const nDel = TXN_COLS.length + 4;
  const sets = TXN_COLS.map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `
    INSERT INTO goods_transactions (salon_id, yclients_txn_id, ${colList}, source, deleted_at)
    VALUES ($1, $2, ${placeholders}, $${nSrc}, ${status === 'delete' ? `COALESCE($${nDel}::timestamptz, NOW())` : `$${nDel}::timestamptz`})
    ON CONFLICT (salon_id, yclients_txn_id) DO UPDATE SET
      ${sets}, source = EXCLUDED.source, updated_at = NOW(),
      deleted_at = ${status === 'delete' ? `COALESCE($${nDel}::timestamptz, NOW())` : 'NULL'}
  `;
  await db.query(sql, params);
  return { deleted: status === 'delete' };
}

/** Цена последнего поступления товара → yclients_goods_catalog.last_receipt_price/at. */
async function refreshLastReceipt(salonId, goodId) {
  const cat = await db.oneOrNone(
    'SELECT unit_equals FROM yclients_goods_catalog WHERE salon_id=$1 AND yclients_good_id=$2', [salonId, goodId]);
  const last = await db.oneOrNone(
    `SELECT create_date, amount, cost, operation_unit_type FROM goods_transactions
     WHERE salon_id=$1 AND good_id=$2 AND type_id=3 AND deleted_at IS NULL AND amount > 0
     ORDER BY create_date DESC, yclients_txn_id DESC LIMIT 1`, [salonId, goodId]);
  const price = last ? receiptUnitPrice(last, cat && cat.unit_equals) : null;
  const at = last ? last.create_date : null;
  await db.query(
    `UPDATE yclients_goods_catalog SET last_receipt_price=$3, last_receipt_at=$4, updated_at=NOW()
     WHERE salon_id=$1 AND yclients_good_id=$2`, [salonId, goodId, price, at]);
  return { price, at };
}

/** Для всех товаров салона с приходами (ночной проход после сверки). */
async function refreshAllLastReceipts(salonId) {
  const goods = await db.any(
    `SELECT DISTINCT good_id FROM goods_transactions WHERE salon_id=$1 AND type_id=3 AND deleted_at IS NULL AND good_id IS NOT NULL`, [salonId]);
  let n = 0;
  for (const g of goods) {
    try { await refreshLastReceipt(salonId, Number(g.good_id)); n++; }
    catch (e) { logger.warn(`refreshLastReceipt good=${g.good_id}: ${e.message}`); }
  }
  return n;
}

/** Апсерт экономических колонок товара; дерево категорий (category_*) не трогает. */
async function upsertCatalogGood(salonId, g) {
  await db.query(`
    INSERT INTO yclients_goods_catalog (salon_id, yclients_good_id, title, unit, service_unit, unit_equals,
      actual_cost, unit_actual_cost, stock, last_seen_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
    ON CONFLICT (salon_id, yclients_good_id) DO UPDATE SET
      title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE yclients_goods_catalog.title END,
      unit = EXCLUDED.unit, service_unit = EXCLUDED.service_unit, unit_equals = EXCLUDED.unit_equals,
      actual_cost = EXCLUDED.actual_cost, unit_actual_cost = EXCLUDED.unit_actual_cost, stock = EXCLUDED.stock,
      last_seen_at = NOW(), updated_at = NOW()
  `, [salonId, g.good_id, g.title || '', g.unit, g.service_unit, g.unit_equals, g.actual_cost, g.unit_actual_cost, JSON.stringify(g.stock || [])]);
}

module.exports = { upsertCatalogGood, upsertGoodsTransaction, refreshLastReceipt, refreshAllLastReceipts, TXN_COLS };
