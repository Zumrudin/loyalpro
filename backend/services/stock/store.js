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
const BALANCES_SQL = `WITH op AS (SELECT good_row_id, storage_id, qty_base, taken_at FROM stock_openings WHERE salon_id = $1),
mv AS (
  SELECT mv.good_row_id, mv.storage_id, SUM(mv.qty_base) AS moved
  FROM stock_movements mv
  JOIN stock_documents d ON d.id = mv.document_id AND d.salon_id = mv.salon_id AND d.status = 'posted'
  LEFT JOIN op ON op.good_row_id = mv.good_row_id AND op.storage_id = mv.storage_id
  WHERE mv.salon_id = $1 AND mv.deleted_at IS NULL
    AND (op.taken_at IS NULL OR mv.occurred_at > op.taken_at
         OR (mv.recorded_at > op.taken_at AND mv.source IN ('webhook','loyalpro','inventory')))
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
