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

// ── Техкарты и привязки ─────────────────────────────────────────────────────

/** Импорт карты YClients: UPSERT по (salon_id, yc_card_id). Возвращает id (или null). */
async function upsertTechCard(salonId, card) {
  const r = await db.oneOrNone(`
    INSERT INTO tech_cards (salon_id, yc_card_id, title, items, source, synced_at, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, 'yclients', NOW(), NOW())
    ON CONFLICT (salon_id, yc_card_id) WHERE yc_card_id IS NOT NULL DO UPDATE SET
      title = EXCLUDED.title, items = EXCLUDED.items, synced_at = NOW(), updated_at = NOW()
    RETURNING id`, [salonId, card.yc_card_id, card.title, JSON.stringify(card.items || [])]);
  return r ? r.id : null;
}

const LINK_SOURCES = new Set(['manual', 'lookup', 'learned']);
// Ранг источника в SQL — зеркало tech-cards.SOURCE_RANK (manual > lookup > learned).
const rankSql = (col) => `(CASE ${col} WHEN 'manual' THEN 0 WHEN 'lookup' THEN 1 ELSE 2 END)`;

/**
 * Привязка услуга(+сотрудник) → техкарта. Перезапись — только источником НЕ
 * МЛАДШЕ существующего: manual перетирает всё, lookup — lookup/learned,
 * learned — только learned. Иначе ночное обучение по факту затирало бы
 * найденную в YClients или выбранную владельцем карту.
 */
async function upsertServiceTechCard(salonId, { serviceYcId, staffYcId = null, techCardId, source }) {
  if (!LINK_SOURCES.has(source)) throw new Error(`upsertServiceTechCard: неизвестный source ${source}`);
  await db.query(`
    INSERT INTO service_tech_cards (salon_id, service_yc_id, staff_yc_id, tech_card_id, source, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (salon_id, service_yc_id, COALESCE(staff_yc_id, 0)) DO UPDATE SET
      tech_card_id = EXCLUDED.tech_card_id, source = EXCLUDED.source, updated_at = NOW()
    WHERE ${rankSql('service_tech_cards.source')} >= ${rankSql('EXCLUDED.source')}`,
  [salonId, serviceYcId, staffYcId, techCardId, source]);
}

/** Map String(yc_card_id) → tech_cards.id. */
async function listTechCardIdsByYc(salonId) {
  const rows = await db.any('SELECT id, yc_card_id FROM tech_cards WHERE salon_id=$1 AND yc_card_id IS NOT NULL', [salonId]);
  return new Map(rows.map(r => [String(r.yc_card_id), r.id]));
}

// Состоявшиеся записи дня со списаниями, у которых хоть одна пара (услуга, сотрудник)
// ещё не привязана ни к одной техкарте, — кандидаты на record_consumables.
const RECORDS_TO_LEARN_SQL = `
    SELECT r.yclients_record_id AS record_id, (r.staff->>'id')::bigint AS staff_yc_id
    FROM records r
    WHERE r.salon_id = $1 AND r.visit_date = $2::date AND r.raw_payload->>'attendance' = '1'
      AND COALESCE(r.status,'') <> 'deleted'
      AND EXISTS (SELECT 1 FROM goods_transactions t WHERE t.salon_id = r.salon_id AND t.record_id = r.yclients_record_id AND t.type_id = 2 AND t.deleted_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.services) = 'array' THEN r.services ELSE '[]'::jsonb END) s
        WHERE NOT EXISTS (SELECT 1 FROM service_tech_cards l WHERE l.salon_id = r.salon_id
          AND l.service_yc_id = (s->>'id')::bigint AND (l.staff_yc_id IS NULL OR l.staff_yc_id = (r.staff->>'id')::bigint)))
    ORDER BY r.yclients_record_id LIMIT $3`;

async function listRecordsToLearn(salonId, day, limit) {
  return db.any(RECORDS_TO_LEARN_SQL, [salonId, day, limit]);
}

module.exports = { upsertCatalogGood, upsertGoodsTransaction, refreshLastReceipt, refreshAllLastReceipts, TXN_COLS,
  upsertTechCard, upsertServiceTechCard, listTechCardIdsByYc, listRecordsToLearn, RECORDS_TO_LEARN_SQL };
