'use strict';
// /api/stock — склад: справочники, каталог, локальные товары. Только owner/admin.
// Поля JWT — req.user.salonId / req.user.userId. Тексты YClients наружу не отдаём.
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const store = require('../services/stock/store');
const catalog = require('../services/stock/catalog-sync');
const documents = require('../services/stock/documents');
const { StockError } = require('../services/stock/model');
const { getReference } = require('../services/journal/reference-cache');
const { createLogger } = require('../logger');
const logger = createLogger('StockAPI');

router.use(auth, requireRole('owner', 'admin'));

const wrap = (label, fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof StockError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.errors ? { errors: e.errors } : {}) });
    if (e && e.code === '23505') return res.status(409).json({ error: 'Такая запись уже есть.' });
    logger.warn(`${label}: ${e && e.message}`);
    res.status(502).json({ error: 'unavailable' });
  }
};
const bad = (res, errors) => res.status(400).json({ error: errors[0], errors });
const id = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const optId = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isInteger(n) && n > 0 ? n : NaN; };
const optStr = (v, max) => (v === undefined || v === null || v === '' ? null : (typeof v === 'string' && v.length <= max ? v : NaN));

// ── Настройки ──
router.get('/settings', wrap('settings', async (req, res) => res.json(await store.getSettings(req.user.salonId))));
router.put('/settings', wrap('settings-save', async (req, res) => {
  const b = bodyOf(req); const p = {}; const errors = [];
  // enabled ставит только scripts/stock-opening.js (снимок остатков) — через API не меняется.
  for (const k of ['defaultSaleStorageId', 'defaultServiceStorageId']) {
    if (!(k in b)) continue;
    const n = optId(b[k]);
    if (Number.isNaN(n)) { errors.push(`${k}: id склада или null.`); continue; }
    if (n !== null) { const s = await store.storageById(req.user.salonId, n); if (!s) { errors.push(`${k}: склад не найден.`); continue; } }
    p[k] = n;
  }
  if (errors.length) return bad(res, errors);
  res.json(await store.saveSettings(req.user.salonId, p));
}));

// ── Справочники одним запросом (без походов в YClients) ──
router.get('/dictionaries', wrap('dictionaries', async (req, res) => {
  const salonId = req.user.salonId;
  const [storages, units, suppliers, staffRaw, paths] = await Promise.all([
    store.listStorages(salonId), store.listUnits(salonId), store.listSuppliers(salonId),
    getReference(salonId, 'staff').catch(() => null), store.distinctCategoryPaths(salonId)]);
  const staff = (Array.isArray(staffRaw) ? staffRaw : []).filter(s => s && !s.fired).map(s => ({ id: s.id, name: s.name, specialization: s.specialization || null }));
  const seen = new Set(); const categories = [];
  for (const r of paths) { const k = JSON.stringify(r.category_path); if (!seen.has(k)) { seen.add(k); categories.push(r.category_path); } }
  res.json({ storages, units, suppliers, staff, categories });
}));

// ── Склады ──
router.get('/storages', wrap('storages', async (req, res) => res.json(await store.listStorages(req.user.salonId))));
router.post('/storages/sync', wrap('storages-sync', async (req, res) => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [req.user.salonId]);
  if (!salon) return res.status(404).json({ error: 'Салон не найден.' });
  res.json(await catalog.syncStorages(salon));
}));
router.post('/storages', wrap('storage-create', async (req, res) => {
  const b = bodyOf(req); const errors = [];
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 200) errors.push('Название: от 1 до 200 символов.');
  for (const k of ['forService', 'forSale']) if (k in b && typeof b[k] !== 'boolean') errors.push(`${k}: true или false.`);
  if (errors.length) return bad(res, errors);
  res.status(201).json(await store.insertLocalStorage(req.user.salonId, { title: b.title.trim(), forService: b.forService === true, forSale: b.forSale === true }));
}));
router.put('/storages/:id', wrap('storage-update', async (req, res) => {
  const sid = id(req); if (!sid) return res.status(400).json({ error: 'Некорректный id.' });
  const cur = await store.storageById(req.user.salonId, sid);
  if (!cur) return res.status(404).json({ error: 'Склад не найден.' });
  const b = bodyOf(req); const errors = []; const p = {};
  if ('isActive' in b) { if (typeof b.isActive !== 'boolean') errors.push('isActive: true или false.'); else p.isActive = b.isActive; }
  if (cur.yclients_storage_id === null) {
    if ('title' in b) { if (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 200) errors.push('Название: от 1 до 200 символов.'); else p.title = b.title.trim(); }
    for (const k of ['forService', 'forSale']) if (k in b) { if (typeof b[k] !== 'boolean') errors.push(`${k}: true или false.`); else p[k] = b[k]; }
  }
  if (errors.length) return bad(res, errors);
  res.json(await store.updateStorage(req.user.salonId, sid, p));
}));

// ── Единицы ──
const unitBody = (b, partial) => {
  const errors = []; const p = {};
  if (!partial || 'title' in b) { if (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 100) errors.push('Название: от 1 до 100 символов.'); else p.title = b.title.trim(); }
  if (!partial || 'shortTitle' in b) { if (typeof b.shortTitle !== 'string' || !b.shortTitle.trim() || b.shortTitle.trim().length > 50) errors.push('Сокращение: от 1 до 50 символов.'); else p.shortTitle = b.shortTitle.trim(); }
  return { errors, p };
};
router.get('/units', wrap('units', async (req, res) => res.json(await store.listUnits(req.user.salonId))));
router.post('/units', wrap('unit-create', async (req, res) => {
  const { errors, p } = unitBody(bodyOf(req), false); if (errors.length) return bad(res, errors);
  res.status(201).json(await store.insertLocalUnit(req.user.salonId, p));
}));
router.put('/units/:id', wrap('unit-update', async (req, res) => {
  const uid = id(req); if (!uid) return res.status(400).json({ error: 'Некорректный id.' });
  const { errors, p } = unitBody(bodyOf(req), true); if (errors.length) return bad(res, errors);
  const r = await store.updateUnit(req.user.salonId, uid, p);
  if (!r) return res.status(404).json({ error: 'Единица не найдена или пришла из YClients.' });
  res.json(r);
}));

// ── Поставщики ──
const supplierBody = (b, partial) => {
  const errors = []; const p = {};
  if (!partial || 'title' in b) { if (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 255) errors.push('Название: от 1 до 255 символов.'); else p.title = b.title.trim(); }
  for (const [k, max] of [['inn', 20], ['phone', 32], ['email', 120], ['contact', 255], ['comment', 2000]]) {
    if (!(k in b)) continue;
    const s = optStr(b[k], max); if (Number.isNaN(s)) errors.push(`${k}: не длиннее ${max} символов.`); else p[k] = s;
  }
  return { errors, p };
};
router.get('/suppliers', wrap('suppliers', async (req, res) => res.json(await store.listSuppliers(req.user.salonId))));
router.post('/suppliers', wrap('supplier-create', async (req, res) => {
  const { errors, p } = supplierBody(bodyOf(req), false); if (errors.length) return bad(res, errors);
  res.status(201).json(await store.insertSupplier(req.user.salonId, p));
}));
router.put('/suppliers/:id', wrap('supplier-update', async (req, res) => {
  const sid = id(req); if (!sid) return res.status(400).json({ error: 'Некорректный id.' });
  const { errors, p } = supplierBody(bodyOf(req), true); if (errors.length) return bad(res, errors);
  const r = await store.updateSupplier(req.user.salonId, sid, p);
  if (!r) return res.status(404).json({ error: 'Поставщик не найден.' });
  res.json(r);
}));
router.delete('/suppliers/:id', wrap('supplier-delete', async (req, res) => {
  const sid = id(req); if (!sid) return res.status(400).json({ error: 'Некорректный id.' });
  const r = await store.softDeleteSupplier(req.user.salonId, sid);
  if (!r) return res.status(404).json({ error: 'Поставщик не найден.' });
  res.json({ ok: true });
}));

// ── Категории и товары ──
router.post('/categories/sync', requireRole('owner'), wrap('categories-sync', async (req, res) => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [req.user.salonId]);
  if (!salon) return res.status(404).json({ error: 'Салон не найден.' });
  res.json(await catalog.syncCategories(salon, { force: bodyOf(req).force === true }));
}));
router.get('/goods', wrap('goods', async (req, res) => {
  const q = req.query || {};
  res.json(await store.listGoods(req.user.salonId, {
    search: typeof q.search === 'string' ? q.search.slice(0, 100) : '',
    source: typeof q.source === 'string' ? q.source : null,
    active: q.active === 'true' ? true : q.active === 'false' ? false : null }));
}));
router.post('/goods', wrap('good-create', async (req, res) => {
  const b = bodyOf(req);
  const good = await catalog.createLocalGood(req.user.salonId, req.user.userId, b);
  const existing = await store.listGoods(req.user.salonId, {});
  const warnings = catalog.similarTitles(good.title, existing.filter(g => g.id !== good.id)).slice(0, 5)
    .map(g => `Похожий товар уже есть: «${g.title}».`);
  res.status(201).json({ good, warnings });
}));
router.put('/goods/:id', wrap('good-update', async (req, res) => {
  const gid = id(req); if (!gid) return res.status(400).json({ error: 'Некорректный id.' });
  res.json(await catalog.updateGood(req.user.salonId, gid, bodyOf(req)));
}));

// ── Остатки и документы ──
router.get('/balances', wrap('balances', async (req, res) => {
  const q = req.query || {}; const storageId = optId(q.storage);
  if (Number.isNaN(storageId)) return bad(res, ['Некорректный id склада.']);
  const [rows, goods] = await Promise.all([store.balances(req.user.salonId, { storageId }), store.listGoods(req.user.salonId)]);
  const byId = new Map(goods.map(g => [String(g.id), g]));
  const result = rows.map(r => {
    const g = byId.get(String(r.good_row_id)) || {};
    return { ...r, title: g.title, unit: g.unit, service_unit: g.service_unit, unit_equals: g.unit_equals,
      critical_amount: g.critical_amount, category_path: g.category_path, local_category: g.local_category };
  }).filter(r => (!q.category || documents.categoryMatches(r, q.category)) &&
    (q.only_negative !== '1' || Number(r.qty_base) < 0) &&
    (q.only_critical !== '1' || (r.critical_amount != null && Number(r.qty_base) <= Number(r.critical_amount) * (Number(r.unit_equals) || 1))));
  res.json(result);
}));
router.post('/documents', wrap('document-create', async (req, res) => {
  res.status(201).json(await documents.create(req.user.salonId, req.user.userId, bodyOf(req)));
}));
router.get('/documents/:id', wrap('document', async (req, res) => {
  const did = id(req); if (!did) return bad(res, ['Некорректный id.']);
  res.json(await documents.detail(req.user.salonId, did));
}));
router.post('/documents/:id/cancel', wrap('document-cancel', async (req, res) => {
  const did = id(req); if (!did) return bad(res, ['Некорректный id.']);
  res.json(await documents.cancel(req.user.salonId, req.user.userId, did, bodyOf(req).reason));
}));
router.post('/inventories', wrap('inventory-create', async (req, res) => {
  res.status(201).json(await documents.inventoryCreate(req.user.salonId, req.user.userId, bodyOf(req)));
}));
router.get('/inventories/:id', wrap('inventory', async (req, res) => {
  const did = id(req); if (!did) return bad(res, ['Некорректный id.']);
  res.json(await documents.detail(req.user.salonId, did, true));
}));
router.put('/inventories/:id/lines', wrap('inventory-lines', async (req, res) => {
  const did = id(req); if (!did) return bad(res, ['Некорректный id.']);
  res.json(await documents.inventorySetLines(req.user.salonId, did, bodyOf(req).lines));
}));
router.post('/inventories/:id/post', wrap('inventory-post', async (req, res) => {
  const did = id(req); if (!did) return bad(res, ['Некорректный id.']);
  res.json(await documents.inventoryPost(req.user.salonId, req.user.userId, did));
}));
router.post('/openings/reset', requireRole('owner'), wrap('opening-reset', async (req, res) => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [req.user.salonId]);
  if (!salon) return res.status(404).json({ error: 'Салон не найден.' });
  res.json(await documents.openingReset(salon, req.user.userId, bodyOf(req)));
}));

module.exports = router;
