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
  `SELECT DISTINCT unit_id, unit, service_unit_id, service_unit FROM yclients_goods_catalog WHERE salon_id = $1 AND (unit_id IS NOT NULL OR service_unit_id IS NOT NULL)`, [salonId]);
const txnUnitRows = (salonId) => db.any(
  `SELECT DISTINCT raw->'unit' AS unit FROM goods_transactions WHERE salon_id = $1 AND jsonb_typeof(raw->'unit') = 'object'`, [salonId]);
const distinctCategoryPaths = (salonId) => db.any(
  `SELECT DISTINCT category_path FROM yclients_goods_catalog WHERE salon_id = $1 AND category_path IS NOT NULL`, [salonId]);

module.exports = { listStorages, storageById, upsertStorage, deactivateMissingStorages, insertLocalStorage, updateStorage,
  listUnits, unitById, upsertUnit, insertLocalUnit, updateUnit,
  listSuppliers, insertSupplier, updateSupplier, softDeleteSupplier,
  getSettings, saveSettings, touchCategoriesSynced,
  listGoods, goodById, setGoodActiveByYcId, updateCatalogPaths, goodUnitsRows, txnUnitRows, distinctCategoryPaths };
