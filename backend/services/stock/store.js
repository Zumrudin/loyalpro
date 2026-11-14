'use strict';
// SQL склада: справочники, настройки, товары. Всё с salon_id. db.one ≡ db.oneOrNone (null при отсутствии).
const { db } = require('../../db');

// ── Склады ──
const STORAGE_COLS = 'id, yclients_storage_id, title, for_service, for_sale, comment, weight, is_active, synced_at';
const listStorages = (salonId) => db.any(`SELECT ${STORAGE_COLS} FROM stock_storages WHERE salon_id = $1 ORDER BY is_active DESC, weight NULLS LAST, title`, [salonId]);
const storageById = (salonId, id) => db.oneOrNone(`SELECT ${STORAGE_COLS} FROM stock_storages WHERE salon_id = $1 AND id = $2`, [salonId, id]);
async function upsertStorage(salonId, s) {
  return db.oneOrNone(`
    INSERT INTO stock_storages (salon_id, yclients_storage_id, title, for_service, for_sale, comment, weight, is_active, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
    ON CONFLICT (salon_id, yclients_storage_id) WHERE yclients_storage_id IS NOT NULL DO UPDATE SET
      title = EXCLUDED.title, for_service = EXCLUDED.for_service, for_sale = EXCLUDED.for_sale,
      comment = EXCLUDED.comment, weight = EXCLUDED.weight, is_active = TRUE, synced_at = NOW()
    RETURNING ${STORAGE_COLS}`, [salonId, s.ycStorageId, s.title, !!s.forService, !!s.forSale, s.comment ?? null, s.weight ?? null]);
}
const deactivateMissingStorages = (salonId, ycIds) => db.query(
  `UPDATE stock_storages SET is_active = FALSE WHERE salon_id = $1 AND yclients_storage_id IS NOT NULL AND is_active AND NOT (yclients_storage_id = ANY($2::bigint[]))`,
  [salonId, ycIds]);
const insertLocalStorage = (salonId, s) => db.oneOrNone(`
  INSERT INTO stock_storages (salon_id, yclients_storage_id, title, for_service, for_sale, comment, is_active)
  VALUES ($1, NULL, $2, $3, $4, $5, TRUE) RETURNING ${STORAGE_COLS}`, [salonId, s.title, !!s.forService, !!s.forSale, s.comment ?? null]);
const updateStorage = (salonId, id, p) => db.oneOrNone(`
  UPDATE stock_storages SET title = COALESCE($3, title), for_service = COALESCE($4, for_service),
    for_sale = COALESCE($5, for_sale), is_active = COALESCE($6, is_active)
  WHERE salon_id = $1 AND id = $2 RETURNING ${STORAGE_COLS}`, [salonId, id, p.title ?? null, p.forService ?? null, p.forSale ?? null, p.isActive ?? null]);

// ── Единицы ──
const listUnits = (salonId) => db.any('SELECT id, yclients_unit_id, title, short_title FROM stock_units WHERE salon_id = $1 ORDER BY lower(short_title)', [salonId]);
const unitById = (salonId, id) => db.oneOrNone('SELECT id, yclients_unit_id, title, short_title FROM stock_units WHERE salon_id = $1 AND id = $2', [salonId, id]);
const upsertUnit = (salonId, u) => db.oneOrNone(`
  INSERT INTO stock_units (salon_id, yclients_unit_id, title, short_title) VALUES ($1, $2, $3, $4)
  ON CONFLICT (salon_id, yclients_unit_id) WHERE yclients_unit_id IS NOT NULL DO UPDATE SET title = EXCLUDED.title, short_title = EXCLUDED.short_title
  RETURNING id, yclients_unit_id, title, short_title`, [salonId, u.ycUnitId, String(u.title).slice(0, 100), String(u.shortTitle).slice(0, 50)]);
const insertLocalUnit = (salonId, u) => db.oneOrNone(
  'INSERT INTO stock_units (salon_id, yclients_unit_id, title, short_title) VALUES ($1, NULL, $2, $3) RETURNING id, yclients_unit_id, title, short_title',
  [salonId, u.title, u.shortTitle]);
const updateUnit = (salonId, id, u) => db.oneOrNone(`
  UPDATE stock_units SET title = COALESCE($3, title), short_title = COALESCE($4, short_title)
  WHERE salon_id = $1 AND id = $2 AND yclients_unit_id IS NULL RETURNING id, yclients_unit_id, title, short_title`,
[salonId, id, u.title ?? null, u.shortTitle ?? null]);

// ── Поставщики ──
const SUP_COLS = 'id, title, inn, phone, email, contact, comment, is_active';
const listSuppliers = (salonId) => db.any(`SELECT ${SUP_COLS} FROM stock_suppliers WHERE salon_id = $1 AND is_active ORDER BY lower(title)`, [salonId]);
const insertSupplier = (salonId, s) => db.oneOrNone(`
  INSERT INTO stock_suppliers (salon_id, title, inn, phone, email, contact, comment) VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING ${SUP_COLS}`, [salonId, s.title, s.inn ?? null, s.phone ?? null, s.email ?? null, s.contact ?? null, s.comment ?? null]);
const updateSupplier = (salonId, id, s) => db.oneOrNone(`
  UPDATE stock_suppliers SET title = COALESCE($3, title), inn = COALESCE($4, inn), phone = COALESCE($5, phone),
    email = COALESCE($6, email), contact = COALESCE($7, contact), comment = COALESCE($8, comment), updated_at = NOW()
  WHERE salon_id = $1 AND id = $2 AND is_active RETURNING ${SUP_COLS}`,
[salonId, id, s.title ?? null, s.inn ?? null, s.phone ?? null, s.email ?? null, s.contact ?? null, s.comment ?? null]);
const softDeleteSupplier = (salonId, id) => db.oneOrNone(
  'UPDATE stock_suppliers SET is_active = FALSE, updated_at = NOW() WHERE salon_id = $1 AND id = $2 AND is_active RETURNING id', [salonId, id]);

// ── Настройки ──
const SET_COLS = 'enabled, default_sale_storage_id, default_service_storage_id, categories_synced_at';
async function getSettings(salonId) {
  await db.query('INSERT INTO stock_settings (salon_id) VALUES ($1) ON CONFLICT DO NOTHING', [salonId]);
  return db.oneOrNone(`SELECT ${SET_COLS} FROM stock_settings WHERE salon_id = $1`, [salonId]);
}
async function saveSettings(salonId, p) {
  await db.query('INSERT INTO stock_settings (salon_id) VALUES ($1) ON CONFLICT DO NOTHING', [salonId]);
  return db.oneOrNone(`
    UPDATE stock_settings SET
      enabled = CASE WHEN $2::boolean IS NULL THEN enabled ELSE $2 END,
      default_sale_storage_id = CASE WHEN $3::boolean THEN $4::bigint ELSE default_sale_storage_id END,
      default_service_storage_id = CASE WHEN $5::boolean THEN $6::bigint ELSE default_service_storage_id END,
      updated_at = NOW()
    WHERE salon_id = $1 RETURNING ${SET_COLS}`,
  [salonId, p.enabled ?? null, 'defaultSaleStorageId' in p, p.defaultSaleStorageId ?? null, 'defaultServiceStorageId' in p, p.defaultServiceStorageId ?? null]);
}
const touchCategoriesSynced = (salonId) => db.query(`
  INSERT INTO stock_settings (salon_id, categories_synced_at) VALUES ($1, NOW())
  ON CONFLICT (salon_id) DO UPDATE SET categories_synced_at = NOW()`, [salonId]);

// ── Товары ──
const GOOD_COLS = `id, yclients_good_id, title, unit, service_unit, unit_equals, stock_active, source, local_sale_price, sale_price,
  category_path, local_category, category_title, unit_id, service_unit_id, critical_amount, barcode, local_note, actual_cost, unit_actual_cost`;
async function listGoods(salonId, { search = '', source = null, active = null } = {}) {
  const params = [salonId]; let where = 'salon_id = $1';
  if (search) { params.push(`%${String(search).replace(/[\\%_]/g, '\\$&')}%`); where += ` AND title ILIKE $${params.length}`; }
  if (source === 'yclients' || source === 'loyalpro') { params.push(source); where += ` AND source = $${params.length}`; }
  if (active === true || active === false) { params.push(active); where += ` AND stock_active = $${params.length}`; }
  return db.any(`SELECT ${GOOD_COLS} FROM yclients_goods_catalog WHERE ${where} ORDER BY title LIMIT 2000`, params);
}
const goodById = (salonId, id) => db.oneOrNone(`SELECT ${GOOD_COLS} FROM yclients_goods_catalog WHERE salon_id = $1 AND id = $2`, [salonId, id]);
const setGoodActiveByYcId = (salonId, ycGoodId, active) => db.query(
  'UPDATE yclients_goods_catalog SET stock_active = $3, updated_at = NOW() WHERE salon_id = $1 AND yclients_good_id = $2', [salonId, ycGoodId, !!active]);
const updateCatalogPaths = (salonId, categoryId, path, parentId) => db.query(
  'UPDATE yclients_goods_catalog SET category_path = $3::jsonb, parent_category_id = $4 WHERE salon_id = $1 AND category_id = $2',
  [salonId, categoryId, JSON.stringify(path), parentId ?? null]);
const goodUnitsRows = (salonId) => db.any(
  `SELECT DISTINCT unit_id, unit, service_unit_id, service_unit FROM yclients_goods_catalog
   WHERE salon_id = $1 AND yclients_good_id IS NOT NULL AND (unit_id IS NOT NULL OR service_unit_id IS NOT NULL)`, [salonId]);
const txnUnitRows = (salonId) => db.any(
  `SELECT DISTINCT raw->'unit' AS unit FROM goods_transactions WHERE salon_id = $1 AND jsonb_typeof(raw->'unit') = 'object'`, [salonId]);
const distinctCategoryPaths = (salonId) => db.any(
  `SELECT DISTINCT category_path FROM yclients_goods_catalog WHERE salon_id = $1 AND category_path IS NOT NULL`, [salonId]);

module.exports = { listStorages, storageById, upsertStorage, deactivateMissingStorages, insertLocalStorage, updateStorage,
  listUnits, unitById, upsertUnit, insertLocalUnit, updateUnit,
  listSuppliers, insertSupplier, updateSupplier, softDeleteSupplier,
  getSettings, saveSettings, touchCategoriesSynced,
  listGoods, goodById, setGoodActiveByYcId, updateCatalogPaths, goodUnitsRows, txnUnitRows, distinctCategoryPaths };

// ── Остатки: одно правило для загрузчика и живого EXPLAIN ──
// Правило счёта (§6.3 спеки, уточнено ревью задачи 4): локальные движения (loyalpro, inventory) считаются ВСЕГДА —
// их нет в показании YClients по построению; зеркальные (webhook, reconcile) — только впервые увиденные ПОСЛЕ снимка
// (recorded_at > taken_at); backfill и opening при наличии снимка не считаются. Та же логика — model.balanceCountsRow.
// Предикат «движение входит в остаток» — ОДНО на остатки и оборотку (алиасы: mv — движение, op — снимок пары).
const COUNTED_SQL = `(op.taken_at IS NULL OR mv.source IN ('loyalpro','inventory')
         OR (mv.recorded_at > op.taken_at AND mv.source IN ('webhook','reconcile')))`;
const BALANCES_SQL = `WITH op AS (SELECT good_row_id, storage_id, qty_base, taken_at FROM stock_openings WHERE salon_id = $1),
mv AS (
  SELECT mv.good_row_id, mv.storage_id, SUM(mv.qty_base) AS moved
  FROM stock_movements mv
  JOIN stock_documents d ON d.id = mv.document_id AND d.salon_id = mv.salon_id AND d.status = 'posted'
  LEFT JOIN op ON op.good_row_id = mv.good_row_id AND op.storage_id = mv.storage_id
  WHERE mv.salon_id = $1 AND mv.deleted_at IS NULL
    AND ${COUNTED_SQL}
  GROUP BY mv.good_row_id, mv.storage_id)
SELECT g.id AS good_row_id, s.id AS storage_id, COALESCE(op.qty_base,0) + COALESCE(mv.moved,0) AS qty_base, op.taken_at
FROM yclients_goods_catalog g
CROSS JOIN stock_storages s
LEFT JOIN op ON op.good_row_id = g.id AND op.storage_id = s.id
LEFT JOIN mv ON mv.good_row_id = g.id AND mv.storage_id = s.id
WHERE g.salon_id = $1 AND s.salon_id = $1 AND s.is_active AND (op.good_row_id IS NOT NULL OR mv.good_row_id IS NOT NULL)`;

const balanceCache = new Map();
const invalidateBalances = salonId => balanceCache.delete(String(salonId));
async function balances(salonId, { goodRowIds, storageId } = {}, q) {
  const key = String(salonId);
  let cached = q ? { rows: (await q(BALANCES_SQL, [salonId])).rows, expires: Infinity } : balanceCache.get(key);
  if (!cached || cached.expires <= Date.now()) {
    cached = { rows: await db.any(BALANCES_SQL, [salonId]), expires: Date.now() + 30000 };
    balanceCache.set(key, cached);
  }
  const ids = goodRowIds ? new Set(goodRowIds.map(String)) : null;
  return cached.rows.filter(r => (!ids || ids.has(String(r.good_row_id))) && (storageId == null || String(r.storage_id) === String(storageId)));
}
const goodByYcId = (salonId, ycGoodId) => db.oneOrNone(
  'SELECT id, unit_equals FROM yclients_goods_catalog WHERE salon_id = $1 AND yclients_good_id = $2', [salonId, ycGoodId]);
const ensureStorage = (salonId, ycStorageId, title) => db.oneOrNone(`
  INSERT INTO stock_storages (salon_id, yclients_storage_id, title)
  VALUES ($1, $2, COALESCE($3, $4))
  ON CONFLICT (salon_id, yclients_storage_id) WHERE yclients_storage_id IS NOT NULL
  DO UPDATE SET title = COALESCE($3, stock_storages.title)
  RETURNING id`, [salonId, ycStorageId, title || null, `Склад ${ycStorageId}`]);
const clientIdByYc = async (salonId, ycClientId) => {
  const row = await db.oneOrNone('SELECT id FROM clients WHERE salon_id = $1 AND yclients_client_id = $2', [salonId, ycClientId]);
  return row ? row.id : null;
};
async function addIngestPending(salonId, row) {
  const { client, ...raw } = row.raw || {}; // client.* никогда не сохраняем
  await db.query(`INSERT INTO stock_ingest_pending (salon_id, yclients_txn_id, good_id, raw)
    VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
  [salonId, row.yclients_txn_id, row.good_id, JSON.stringify(raw)]);
}
async function markMovementDeleted(salonId, ycTxnId, at) {
  await db.query('UPDATE stock_movements SET deleted_at = $3 WHERE salon_id = $1 AND yclients_txn_id = $2', [salonId, ycTxnId, at]);
  invalidateBalances(salonId);
}
async function upsertMirrorDocument(salonId, d) {
  return db.oneOrNone(`INSERT INTO stock_documents
    (salon_id, kind, origin, status, yclients_document_id, storage_id, doc_date, record_id, master_staff_yc_id, client_id, yclients_client_id, comment, posted_at)
    VALUES ($1, $2, 'yclients', 'posted', $3, $4,
      COALESCE($5::timestamptz, (SELECT doc_date FROM stock_documents WHERE salon_id = $1 AND yclients_document_id = $3)),
      $6, $7, $8, $9, $10, NOW())
    ON CONFLICT (salon_id, yclients_document_id) WHERE yclients_document_id IS NOT NULL DO UPDATE SET
      kind = EXCLUDED.kind, storage_id = EXCLUDED.storage_id,
      doc_date = COALESCE(EXCLUDED.doc_date, stock_documents.doc_date),
      record_id = COALESCE(EXCLUDED.record_id, stock_documents.record_id),
      master_staff_yc_id = COALESCE(EXCLUDED.master_staff_yc_id, stock_documents.master_staff_yc_id),
      client_id = COALESCE(EXCLUDED.client_id, stock_documents.client_id),
      yclients_client_id = COALESCE(EXCLUDED.yclients_client_id, stock_documents.yclients_client_id),
      comment = COALESCE(EXCLUDED.comment, stock_documents.comment), updated_at = NOW()
    RETURNING id`, [salonId, d.kind, d.ycDocumentId ?? null, d.storageId, d.docDate, d.recordId ?? null,
    d.masterStaffYcId ?? null, d.clientId ?? null, d.ycClientId ?? null, d.comment ?? null]);
}

const MOVEMENT_COLS = ['document_id', 'good_row_id', 'storage_id', 'qty', 'unit_type', 'qty_base',
  'cost_per_unit', 'discount', 'cost', 'record_id', 'service_yc_id', 'master_staff_yc_id',
  'yclients_txn_id', 'source', 'occurred_at', 'comment'];
const movementValues = r => [r.documentId, r.goodRowId, r.storageId, r.qty, r.unitType, r.qtyBase,
  r.costPerUnit ?? null, r.discount ?? null, r.cost ?? null, r.recordId ?? null,
  r.serviceYcId ?? null, r.masterStaffYcId ?? null, r.ycTxnId ?? null, r.source, r.occurredAt, r.comment ?? null];
const MOVEMENT_INSERT = `INSERT INTO stock_movements (salon_id, ${MOVEMENT_COLS.join(', ')})
  VALUES ($1, ${MOVEMENT_COLS.map((_, i) => `$${i + 2}`).join(', ')})`;
async function upsertMovement(salonId, row) {
  const result = await db.oneOrNone(`${MOVEMENT_INSERT}
    ON CONFLICT (salon_id, yclients_txn_id) WHERE yclients_txn_id IS NOT NULL DO UPDATE SET
      qty = EXCLUDED.qty, unit_type = EXCLUDED.unit_type, qty_base = EXCLUDED.qty_base,
      cost_per_unit = EXCLUDED.cost_per_unit, discount = EXCLUDED.discount, cost = EXCLUDED.cost,
      occurred_at = EXCLUDED.occurred_at, document_id = EXCLUDED.document_id,
      good_row_id = EXCLUDED.good_row_id, storage_id = EXCLUDED.storage_id, record_id = EXCLUDED.record_id,
      service_yc_id = EXCLUDED.service_yc_id, master_staff_yc_id = EXCLUDED.master_staff_yc_id,
      deleted_at = NULL
    RETURNING id`, [salonId, ...movementValues(row)]);
  invalidateBalances(salonId);
  return result;
}
async function insertMovement(q, salonId, row) {
  const result = await q(`${MOVEMENT_INSERT} RETURNING id`, [salonId, ...movementValues(row)]);
  invalidateBalances(salonId);
  return result.rows[0];
}
async function insertDocument(q, salonId, d) {
  const result = await q(`INSERT INTO stock_documents
    (salon_id, kind, origin, status, storage_id, to_storage_id, supplier_id, client_id, yclients_client_id,
     record_id, master_staff_yc_id, doc_date, comment, total_cost, created_by, posted_at)
    VALUES ($1, $2, 'loyalpro', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15::timestamptz, CASE WHEN $3 = 'posted' THEN NOW() END)) RETURNING *`,
  [salonId, d.kind, d.status, d.storageId ?? null, d.toStorageId ?? null, d.supplierId ?? null,
    d.clientId ?? null, d.ycClientId ?? null, d.recordId ?? null, d.masterStaffYcId ?? null,
    d.docDate, d.comment ?? null, d.totalCost ?? null, d.createdBy ?? null,
    d.postedAt ?? null]);
  return result.rows[0];
}
const listOpenings = salonId => db.any('SELECT * FROM stock_openings WHERE salon_id = $1 ORDER BY good_row_id, storage_id', [salonId]);
async function insertOpening(q, salonId, r) {
  const result = await q(`INSERT INTO stock_openings
    (salon_id, good_row_id, storage_id, qty_base, yc_qty_base, taken_at, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (salon_id, good_row_id, storage_id) DO UPDATE SET
      qty_base = EXCLUDED.qty_base, yc_qty_base = EXCLUDED.yc_qty_base, taken_at = EXCLUDED.taken_at,
      note = EXCLUDED.note, created_by = EXCLUDED.created_by RETURNING id`,
  [salonId, r.goodRowId, r.storageId, r.qtyBase, r.ycQtyBase ?? null, r.takenAt, r.note ?? null, r.createdBy ?? null]);
  invalidateBalances(salonId);
  return result.rows[0];
}
async function setEnabled(q, salonId, enabled) {
  await q(`INSERT INTO stock_settings (salon_id, enabled, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (salon_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`, [salonId, enabled]);
  invalidateBalances(salonId);
}
Object.assign(module.exports, { BALANCES_SQL, balances, invalidateBalances, goodByYcId, ensureStorage,
  clientIdByYc, addIngestPending, markMovementDeleted, upsertMirrorDocument, upsertMovement,
  insertMovement, insertDocument, listOpenings, insertOpening, setEnabled });

// ── Документы и инвентаризации; q позволяет читать под блокировкой в транзакции ──
async function documentById(salonId, id, q) {
  const sql = 'SELECT * FROM stock_documents WHERE salon_id = $1 AND id = $2';
  return q ? (await q(`${sql} FOR UPDATE`, [salonId, id])).rows[0] || null : db.oneOrNone(sql, [salonId, id]);
}
const listMovementsByDocument = (salonId, docId) => db.any(`
  SELECT m.*, g.title, g.unit, g.service_unit, g.unit_equals, s.title AS storage_title
  FROM stock_movements m
  JOIN yclients_goods_catalog g ON g.id = m.good_row_id AND g.salon_id = m.salon_id
  JOIN stock_storages s ON s.id = m.storage_id AND s.salon_id = m.salon_id
  WHERE m.salon_id = $1 AND m.document_id = $2 ORDER BY m.id`, [salonId, docId]);
const cancelDocument = (q, salonId, id, reason) => q(`
  UPDATE stock_documents SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $3, updated_at = NOW()
  WHERE salon_id = $1 AND id = $2`, [salonId, id, reason]);
const softDeleteDocumentMovements = (q, salonId, id) => q(`
  UPDATE stock_movements SET deleted_at = NOW() WHERE salon_id = $1 AND document_id = $2 AND deleted_at IS NULL`, [salonId, id]);
async function insertInventoryLines(q, salonId, docId, lines) {
  for (const l of lines) await q(`INSERT INTO stock_inventory_lines
    (salon_id, document_id, good_row_id, storage_id, expected_base) VALUES ($1, $2, $3, $4, $5)`,
  [salonId, docId, l.goodRowId, l.storageId, l.expectedBase]);
}
async function listInventoryLines(salonId, docId, q) {
  const sql = `SELECT l.*, g.title, g.unit, g.service_unit, g.unit_equals, s.title AS storage_title
    FROM stock_inventory_lines l
    JOIN yclients_goods_catalog g ON g.id = l.good_row_id AND g.salon_id = l.salon_id
    JOIN stock_storages s ON s.id = l.storage_id AND s.salon_id = l.salon_id
    WHERE l.salon_id = $1 AND l.document_id = $2 ORDER BY l.id`;
  return q ? (await q(sql, [salonId, docId])).rows : db.any(sql, [salonId, docId]);
}
const updateInventoryLine = (q, salonId, docId, l) => q(`UPDATE stock_inventory_lines
  SET expected_base = $4, counted = $5, counted_unit_type = $6, counted_base = $7, diff_base = $8
  WHERE salon_id = $1 AND document_id = $2 AND good_row_id = $3`,
[salonId, docId, l.goodRowId, l.expectedBase, l.counted, l.countedUnitType, l.countedBase, l.diffBase]);
const setDocumentStatus = (q, salonId, id, status) => q(`UPDATE stock_documents
  SET status = $3, posted_at = CASE WHEN $3 = 'posted' THEN NOW() ELSE posted_at END, updated_at = NOW()
  WHERE salon_id = $1 AND id = $2`, [salonId, id, status]);
const postInventory = (q, salonId, id) => setDocumentStatus(q, salonId, id, 'posted');
const currentOpening = (salonId, goodRowId, storageId) => db.oneOrNone(`SELECT * FROM stock_openings
  WHERE salon_id = $1 AND good_row_id = $2 AND storage_id = $3`, [salonId, goodRowId, storageId]);
Object.assign(module.exports, { documentById, listMovementsByDocument, cancelDocument, softDeleteDocumentMovements,
  insertInventoryLines, listInventoryLines, updateInventoryLine, postInventory, setDocumentStatus, currentOpening });

// Покупки обоих источников, включая отменённые документы и подарки без оплат.
const PURCHASES_SQL = `SELECT d.id, d.doc_date, d.origin, d.status, d.total_cost,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('title', g.title, 'qty', m.qty,
    'unit', CASE WHEN m.unit_type=1 THEN g.unit ELSE g.service_unit END, 'cost', m.cost) ORDER BY m.id)
    FROM stock_movements m JOIN yclients_goods_catalog g ON g.id=m.good_row_id AND g.salon_id=m.salon_id
    WHERE m.salon_id=d.salon_id AND m.document_id=d.id), '[]'::jsonb) AS lines,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('method', f.method, 'amount', f.amount, 'status', f.status) ORDER BY f.id)
    FROM finance_operations f WHERE f.salon_id=d.salon_id AND f.stock_document_id=d.id), '[]'::jsonb) AS payments
  FROM stock_documents d WHERE d.salon_id=$1 AND d.kind='sale'
    AND (d.client_id=$2 OR (d.client_id IS NULL AND d.yclients_client_id IN
      (SELECT yclients_client_id FROM clients WHERE salon_id=$1 AND id=$2)))
  ORDER BY d.doc_date DESC, d.id DESC LIMIT 200`;
const listPurchasesByClient = (salonId, clientId) => db.any(PURCHASES_SQL, [salonId, clientId]);
Object.assign(module.exports, { PURCHASES_SQL, listPurchasesByClient });

// ═══ Задача 7: чтение — каталог с остатками, карточка товара, журнал документов, оборотка ═══
const { fromBase } = require('./model');
Object.assign(module.exports, { COUNTED_SQL });

const goodInCategory = (g, category) => category == null || g.local_category === String(category) ||
  (Array.isArray(g.category_path) && g.category_path.some(n => n && String(n.id) === String(category)));
const qtyView = (qtyBase, unitEquals) => {
  const f = fromBase(qtyBase, unitEquals);
  return { sale_units: f.saleUnits, remainder_base: f.remainderBase };
};
const isCritical = (g, qtyBase) => Number(g.critical_amount) > 0 && Number(qtyBase) < Number(g.critical_amount) * (Number(g.unit_equals) || 1);

async function listGoodsWithBalances(salonId, f = {}) {
  const [goods, bal, storages] = await Promise.all([
    listGoods(salonId, { search: f.search || '', source: f.source || null, active: f.active ?? null }),
    balances(salonId, { storageId: f.storage ?? null }), listStorages(salonId)]);
  const sTitle = new Map(storages.map(s => [String(s.id), s.title]));
  const byGood = new Map();
  for (const r of bal) {
    const k = String(r.good_row_id);
    if (!byGood.has(k)) byGood.set(k, []);
    byGood.get(k).push(r);
  }
  const out = [];
  for (const g of goods) {
    if (!goodInCategory(g, f.category)) continue;
    const rows = byGood.get(String(g.id)) || [];
    if (f.storage != null && !rows.length) continue;
    const balancesView = rows.map(r => ({ storage_id: r.storage_id, storage_title: sTitle.get(String(r.storage_id)) || null,
      qty_base: r.qty_base, taken_at: r.taken_at, ...qtyView(r.qty_base, g.unit_equals), critical: isCritical(g, r.qty_base), negative: Number(r.qty_base) < 0 }));
    if (f.onlyCritical && !balancesView.some(b => b.critical)) continue;
    if (f.onlyNegative && !balancesView.some(b => b.negative)) continue;
    out.push({ ...g, balances: balancesView });
  }
  return out;
}

const MOVEMENTS_BY_GOOD_SQL = `SELECT m.id, m.document_id, m.storage_id, s.title AS storage_title, m.qty, m.unit_type, m.qty_base,
    m.cost_per_unit, m.discount, m.cost, m.record_id, m.source, m.occurred_at, m.deleted_at, m.comment,
    d.kind, d.origin, d.status, d.doc_date, d.comment AS document_comment, count(*) OVER() AS total
  FROM stock_movements m
  JOIN stock_documents d ON d.id = m.document_id AND d.salon_id = m.salon_id
  JOIN stock_storages s ON s.id = m.storage_id AND s.salon_id = m.salon_id
  WHERE m.salon_id = $1 AND m.good_row_id = $2
  ORDER BY m.occurred_at DESC, m.id DESC LIMIT $3 OFFSET $4`;
async function listMovementsByGood(salonId, goodRowId, { page = 1, limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200); const pg = Math.max(Number(page) || 1, 1);
  const rows = await db.any(MOVEMENTS_BY_GOOD_SQL, [salonId, goodRowId, lim, (pg - 1) * lim]);
  return { movements: rows.map(({ total, ...r }) => r), total: rows.length ? Number(rows[0].total) : 0, page: pg, limit: lim };
}

const RECEIPTS_BY_GOOD_SQL = `SELECT m.id, m.document_id, m.storage_id, s.title AS storage_title, m.qty, m.unit_type, m.qty_base,
    m.cost_per_unit, m.cost, m.occurred_at, d.origin, d.status, d.supplier_id
  FROM stock_movements m
  JOIN stock_documents d ON d.id = m.document_id AND d.salon_id = m.salon_id
  JOIN stock_storages s ON s.id = m.storage_id AND s.salon_id = m.salon_id
  WHERE m.salon_id = $1 AND m.good_row_id = $2 AND d.kind = 'receipt' AND m.deleted_at IS NULL AND d.status = 'posted'
  ORDER BY m.occurred_at DESC, m.id DESC LIMIT 100`;
const listReceiptsByGood = (salonId, goodRowId) => db.any(RECEIPTS_BY_GOOD_SQL, [salonId, goodRowId]);

const techCardsUsingGood = (salonId, ycGoodId) => ycGoodId == null ? [] : db.any(
  `SELECT id, title FROM tech_cards WHERE salon_id = $1 AND items @> jsonb_build_array(jsonb_build_object('good_id', $2::bigint)) ORDER BY title LIMIT 100`,
  [salonId, ycGoodId]);

async function goodCard(salonId, id) {
  const good = await goodById(salonId, id);
  if (!good) return null;
  const [bal, storages, openings, mv, receipts, techCards] = await Promise.all([
    balances(salonId, { goodRowIds: [id] }), listStorages(salonId),
    db.any('SELECT storage_id, qty_base, yc_qty_base, taken_at, source FROM stock_openings WHERE salon_id = $1 AND good_row_id = $2', [salonId, id]),
    listMovementsByGood(salonId, id, { page: 1, limit: 50 }), listReceiptsByGood(salonId, id), techCardsUsingGood(salonId, good.yclients_good_id)]);
  const sTitle = new Map(storages.map(s => [String(s.id), s.title]));
  const view = r => ({ storage_id: r.storage_id, storage_title: sTitle.get(String(r.storage_id)) || null });
  return {
    good, unitPrice: await goodUnitPrice(salonId,good),
    balances: bal.map(r => ({ ...view(r), qty_base: r.qty_base, taken_at: r.taken_at, ...qtyView(r.qty_base, good.unit_equals), critical: isCritical(good, r.qty_base), negative: Number(r.qty_base) < 0 })),
    openings: openings.map(o => ({ ...view(o), qty_base: o.qty_base, yc_qty_base: o.yc_qty_base, taken_at: o.taken_at, source: o.source })),
    movements: mv, receipts, techCards };
}

// Журнал документов обоих источников; total — window count до LIMIT. Количество строк — по движениям (у инвентаризации они появляются при проведении).
// $1 салон, $2 вид, $3 статус, $4 источник, $5 с (дата), $6 по (дата), $7 клиент, $8 запись, $9 склад, $10 limit, $11 offset
const DOCS_LIST_SQL = `WITH page AS (
  SELECT d.id, d.kind, d.origin, d.status, d.doc_date, d.storage_id, d.to_storage_id, d.supplier_id, d.client_id, d.record_id,
    d.total_cost, d.comment, d.cancel_reason, count(*) OVER() AS total
  FROM stock_documents d
  WHERE d.salon_id = $1
    AND ($2::text IS NULL OR d.kind = $2) AND ($3::text IS NULL OR d.status = $3) AND ($4::text IS NULL OR d.origin = $4)
    AND ($5::date IS NULL OR d.doc_date >= ($5::date)::timestamp AT TIME ZONE 'Europe/Moscow')
    AND ($6::date IS NULL OR d.doc_date < (($6::date) + 1)::timestamp AT TIME ZONE 'Europe/Moscow')
    AND ($7::int IS NULL OR d.client_id = $7) AND ($8::bigint IS NULL OR d.record_id = $8)
    AND ($9::bigint IS NULL OR d.storage_id = $9 OR d.to_storage_id = $9)
  ORDER BY d.doc_date DESC, d.id DESC LIMIT $10 OFFSET $11),
lc AS (SELECT document_id, count(*) AS lines FROM stock_movements
  WHERE salon_id = $1 AND deleted_at IS NULL AND document_id IN (SELECT id FROM page) GROUP BY document_id)
SELECT page.*, COALESCE(lc.lines, 0)::int AS lines_count, s1.title AS storage_title, s2.title AS to_storage_title
FROM page LEFT JOIN lc ON lc.document_id = page.id
LEFT JOIN stock_storages s1 ON s1.id = page.storage_id AND s1.salon_id = $1
LEFT JOIN stock_storages s2 ON s2.id = page.to_storage_id AND s2.salon_id = $1
ORDER BY page.doc_date DESC, page.id DESC`;
async function listDocuments(salonId, f = {}) {
  const limit = f.limit || 50; const page = f.page || 1;
  const rows = await db.any(DOCS_LIST_SQL, [salonId, f.kind ?? null, f.status ?? null, f.origin ?? null, f.from ?? null, f.to ?? null,
    f.client ?? null, f.record ?? null, f.storage ?? null, limit, (page - 1) * limit]);
  return { documents: rows.map(({ total, ...r }) => r), total: rows.length ? Number(rows[0].total) : 0, page, limit };
}

// Оборотка по товару × складу. $1 салон, $2 с, $3 по (даты, включительно, Москва), $4 склад|null.
// начало = снимок + Σ засчитанных движений до $2 (правило COUNTED_SQL), приход/расход — по знаку за период, конец = начало + приход + расход.
const TURNOVER_SQL = `WITH bounds AS (
  SELECT ($2::date)::timestamp AT TIME ZONE 'Europe/Moscow' AS t_from, (($3::date) + 1)::timestamp AT TIME ZONE 'Europe/Moscow' AS t_to),
op AS (SELECT good_row_id, storage_id, qty_base, taken_at FROM stock_openings WHERE salon_id = $1 AND ($4::bigint IS NULL OR storage_id = $4)),
mv AS (
  SELECT mv.good_row_id, mv.storage_id,
    COALESCE(SUM(mv.qty_base) FILTER (WHERE mv.occurred_at < b.t_from), 0) AS before_qty,
    COALESCE(SUM(mv.qty_base) FILTER (WHERE mv.occurred_at >= b.t_from AND mv.occurred_at < b.t_to AND mv.qty_base > 0), 0) AS inflow,
    COALESCE(SUM(mv.qty_base) FILTER (WHERE mv.occurred_at >= b.t_from AND mv.occurred_at < b.t_to AND mv.qty_base < 0), 0) AS outflow
  FROM stock_movements mv
  CROSS JOIN bounds b
  JOIN stock_documents d ON d.id = mv.document_id AND d.salon_id = mv.salon_id AND d.status = 'posted'
  LEFT JOIN op ON op.good_row_id = mv.good_row_id AND op.storage_id = mv.storage_id
  WHERE mv.salon_id = $1 AND mv.deleted_at IS NULL AND mv.occurred_at < b.t_to AND ($4::bigint IS NULL OR mv.storage_id = $4)
    AND ${COUNTED_SQL}
  GROUP BY mv.good_row_id, mv.storage_id),
rows AS (
  SELECT COALESCE(op.good_row_id, mv.good_row_id) AS good_row_id, COALESCE(op.storage_id, mv.storage_id) AS storage_id,
    COALESCE(op.qty_base, 0) + COALESCE(mv.before_qty, 0) AS start_qty, COALESCE(mv.inflow, 0) AS inflow, COALESCE(mv.outflow, 0) AS outflow
  FROM op FULL JOIN mv ON mv.good_row_id = op.good_row_id AND mv.storage_id = op.storage_id)
SELECT r.good_row_id, g.yclients_good_id, g.title, g.unit, g.service_unit, g.unit_equals, g.category_path, g.local_category,
  r.storage_id, s.title AS storage_title, r.start_qty, r.inflow, r.outflow, r.start_qty + r.inflow + r.outflow AS end_qty
FROM rows r
JOIN yclients_goods_catalog g ON g.id = r.good_row_id AND g.salon_id = $1
JOIN stock_storages s ON s.id = r.storage_id AND s.salon_id = $1
WHERE r.start_qty <> 0 OR r.inflow <> 0 OR r.outflow <> 0
ORDER BY g.title, s.title`;
async function turnover(salonId, { from, to, storage = null, category = null }) {
  const rows = await db.any(TURNOVER_SQL, [salonId, from, to, storage]);
  return rows.filter(r => goodInCategory(r, category)).map(r => ({ ...r,
    start: qtyView(r.start_qty, r.unit_equals), inflow_view: qtyView(r.inflow, r.unit_equals),
    outflow_view: qtyView(r.outflow, r.unit_equals), end: qtyView(r.end_qty, r.unit_equals) }));
}
Object.assign(module.exports, { listGoodsWithBalances, goodCard, listMovementsByGood, listReceiptsByGood, techCardsUsingGood,
  MOVEMENTS_BY_GOOD_SQL, RECEIPTS_BY_GOOD_SQL, DOCS_LIST_SQL, listDocuments, TURNOVER_SQL, turnover });

const listDocumentPayments = (salonId, docId) => db.any(`SELECT method, amount, status FROM finance_operations WHERE salon_id=$1 AND stock_document_id=$2 ORDER BY id`, [salonId, docId]);
module.exports.listDocumentPayments = listDocumentPayments;

async function consumablesContext(salonId, recordId) {
  let services, staffId, date;
  if (recordId < 0) {
    const r = await require('../journal').detail(salonId, recordId);
    services = r.services; staffId = r.staffId; date = r.date;
    if (r.id < 0) {
      const local = await db.any('SELECT id, economics_yc_id, yclients_id FROM service_catalog WHERE salon_id=$1 AND id=ANY($2::int[])', [salonId, services.map(s=>s.id)]);
      services = services.map(s=>({...s, yclients_id: local.find(l=>Number(l.id)===Number(s.id))?.economics_yc_id || local.find(l=>Number(l.id)===Number(s.id))?.yclients_id || 0}));
    }
  } else {
    const r = await db.oneOrNone('SELECT raw_payload, staff_id, visit_date FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, recordId]);
    if (!r) return null;
    services = r.raw_payload?.services || []; staffId = r.staff_id; date = r.visit_date;
  }
  const [goods, links, cards, overrides] = await Promise.all([listGoods(salonId),
    db.any('SELECT * FROM service_tech_cards WHERE salon_id=$1', [salonId]),
    db.any('SELECT id, items FROM tech_cards WHERE salon_id=$1', [salonId]),
    db.any('SELECT good_id, unit_price FROM goods_price_overrides WHERE salon_id=$1', [salonId])]);
  return { services, staffId, date, goods, links, cards, overrides };
}
async function recordConsumableMovements(salonId, recordId, q) {
  const sql = `SELECT m.good_row_id, m.service_yc_id, m.storage_id, m.qty_base, m.cost, d.origin
    FROM stock_movements m JOIN stock_documents d ON d.id=m.document_id AND d.salon_id=m.salon_id
    WHERE m.salon_id=$1 AND m.record_id=$2 AND d.kind='consumable' AND d.status='posted' AND m.deleted_at IS NULL`;
  return q ? (await q(sql,[salonId,recordId])).rows : db.any(sql,[salonId,recordId]);
}
const stockPriceReceipts = (salonId, good) => listReceipts(salonId, good.id);
Object.assign(module.exports, { consumablesContext, recordConsumableMovements, stockPriceReceipts });

// Replay the current mirror, never a stale queued payload. Deleted rows must also drain.
const pendingMirrorRows = salonId => db.any(`SELECT g.* FROM stock_ingest_pending p
  JOIN goods_transactions g ON g.salon_id=p.salon_id AND g.yclients_txn_id=p.yclients_txn_id
  WHERE p.salon_id=$1 AND (g.deleted_at IS NOT NULL OR EXISTS
    (SELECT 1 FROM yclients_goods_catalog c WHERE c.salon_id=p.salon_id AND c.yclients_good_id=g.good_id))
  ORDER BY p.created_at, p.yclients_txn_id LIMIT 1000`, [salonId]);
const removeIngestPending = (salonId,id) => db.query('DELETE FROM stock_ingest_pending WHERE salon_id=$1 AND yclients_txn_id=$2',[salonId,id]);
const pendingCount = async salonId => Number((await db.oneOrNone('SELECT count(*) AS n FROM stock_ingest_pending WHERE salon_id=$1',[salonId]))?.n || 0);
Object.assign(module.exports,{pendingMirrorRows,removeIngestPending,pendingCount});

const STOCK_RECEIPTS_SQL = `SELECT m.occurred_at AS create_date, ABS(m.qty_base) AS amount, m.cost, 2 AS operation_unit_type
  FROM stock_movements m JOIN stock_documents d ON d.id=m.document_id AND d.salon_id=m.salon_id
  WHERE m.salon_id=$1 AND m.good_row_id=$2 AND d.kind='receipt' AND d.status='posted' AND m.deleted_at IS NULL AND m.qty_base>0
  ORDER BY m.occurred_at DESC, m.id DESC`;
const listReceipts = (salonId, goodRowId) => db.any(STOCK_RECEIPTS_SQL,[salonId,goodRowId]);
async function goodUnitPrice(salonId, good, date=new Date()) {
  const override=good.yclients_good_id == null ? null : await db.oneOrNone('SELECT unit_price FROM goods_price_overrides WHERE salon_id=$1 AND good_id=$2',[salonId,good.yclients_good_id]);
  return require('../economics/price').unitPriceAsOf({receipts:await listReceipts(salonId,good.id),override,catalogRow:good,date});
}
Object.assign(module.exports,{listReceipts,STOCK_RECEIPTS_SQL,goodUnitPrice});
