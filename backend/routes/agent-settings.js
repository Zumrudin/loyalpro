'use strict';
// ============================================================
// Agent settings API — управление ИИ-агентом из админки (owner/admin).
// Тумблер вкл/выкл, режим допуска (all|whitelist), белый/чёрный списки номеров.
// ============================================================
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { auth, requireRole } = require('../middleware/auth');
const settings = require('../services/agent-settings');
const priceListData = require('../services/agent/price-list-data');
const { imageFileFilter } = require('../utils/upload-validator');
const { createLogger } = require('../logger');
const logger = createLogger('AgentSettings');

// Best-effort сброс TTL-кэша индекса прайсов (price-list-data.js) после мутации:
// сбой сброса не имеет права ронять ответ ручки, но без него администратор до
// минуты недоумевал бы, почему загруженное/удалённое/переупорядоченное фото
// Мила не видит (или видит устаревший порядок).
function invalidatePriceIndex(salonId) {
  try { priceListData.invalidate(salonId); }
  catch (e) { logger.warn(`не сбросить кэш индекса прайсов (${e.message})`); }
}

const adminOnly = [auth, requireRole('owner', 'admin')];

// ── multer storage для фото прайс-листа (имя файла собираем сами) ─────────
const uploadsDir = path.join(__dirname, '../../frontend/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const priceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

function safeUnlink(relUrl) {
  if (!relUrl || !relUrl.startsWith('/uploads/')) return;
  const abs = path.join(uploadsDir, path.basename(relUrl));
  fs.unlink(abs, (err) => {
    if (err && err.code !== 'ENOENT') logger.warn(`unlink ${abs}: ${err.message}`);
  });
}

// GET /api/agent/settings → { enabled, mode, scheduleEnabled, scheduleStart, scheduleEnd }
router.get('/settings', adminOnly, async (req, res) => {
  try { res.json(await settings.getSettings(req.user.salonId)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// PUT /api/agent/settings { enabled, mode, scheduleEnabled, scheduleStart, scheduleEnd }
router.put('/settings', adminOnly, async (req, res) => {
  try {
    res.json(await settings.updateSettings(req.user.salonId, req.body || {}));
  } catch (e) {
    if (e.code === 'BAD_TIME')
      return res.status(400).json({ error: 'Некорректное время расписания' });
    if (e.code === 'BAD_URL')
      return res.status(400).json({ error: 'Ссылка на прайс должна начинаться с http:// или https://' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// GET /api/agent/number-rules?type=allow|block → { rules: [...] }
router.get('/number-rules', adminOnly, async (req, res) => {
  try {
    const type = (req.query.type === 'allow' || req.query.type === 'block') ? req.query.type : null;
    res.json({ rules: await settings.listNumberRules(req.user.salonId, type) });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// POST /api/agent/number-rules { phone, ruleType, note }
router.post('/number-rules', adminOnly, async (req, res) => {
  try {
    const { phone, ruleType, note } = req.body || {};
    res.json(await settings.addNumberRule(req.user.salonId, { phone, ruleType, note }));
  } catch (e) {
    if (e.code === 'BAD_PHONE') return res.status(400).json({ error: 'Некорректный номер' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/agent/number-rules/:id
router.delete('/number-rules/:id', adminOnly, async (req, res) => {
  try {
    await settings.removeNumberRule(req.user.salonId, parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// GET /api/agent/service-settings → { serviceMode }
router.get('/service-settings', adminOnly, async (req, res) => {
  try { res.json({ serviceMode: await settings.getServiceMode(req.user.salonId) }); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// PUT /api/agent/service-settings { serviceMode }
router.put('/service-settings', adminOnly, async (req, res) => {
  try { res.json(await settings.updateServiceMode(req.user.salonId, (req.body || {}).serviceMode)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// GET /api/agent/services → живой список YClients + видимость
router.get('/services', adminOnly, async (req, res) => {
  try { res.json(await settings.getServicesForAdmin(req.user.salonId)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// GET /api/agent/service-rules → { rules }
router.get('/service-rules', adminOnly, async (req, res) => {
  try { res.json({ rules: await settings.listServiceRules(req.user.salonId) }); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// POST /api/agent/service-rules { ycServiceId, ycStaffId?, ruleType, note }
router.post('/service-rules', adminOnly, async (req, res) => {
  try {
    const { ycServiceId, ycStaffId, ruleType, note } = req.body || {};
    res.json(await settings.addServiceRule(req.user.salonId, { ycServiceId, ycStaffId, ruleType, note }));
  } catch (e) {
    if (e.code === 'BAD_SERVICE') return res.status(400).json({ error: 'Не указана услуга' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// POST /api/agent/service-rules/bulk-visibility { items:[{ycServiceId, active, wantVisible}] }
// Массовый тумблер (чекбокс категории): показать/скрыть все услуги разом.
router.post('/service-rules/bulk-visibility', adminOnly, async (req, res) => {
  try {
    res.json(await settings.setServicesVisibilityBulk(req.user.salonId, (req.body || {}).items));
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// DELETE /api/agent/service-rules/:id
router.delete('/service-rules/:id', adminOnly, async (req, res) => {
  try {
    await settings.removeServiceRule(req.user.salonId, parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// ── Подкатегории услуг + перемещение услуг ──────────────────────────────────

// GET /api/agent/service-subcategories → { subcategories }
router.get('/service-subcategories', adminOnly, async (req, res) => {
  try { res.json({ subcategories: await settings.listSubcategories(req.user.salonId) }); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// POST /api/agent/service-subcategories { ycCategoryId, parentId?, title }
router.post('/service-subcategories', adminOnly, async (req, res) => {
  try {
    const { ycCategoryId, parentId, title } = req.body || {};
    res.json(await settings.addSubcategory(req.user.salonId, { ycCategoryId, parentId, title }));
  } catch (e) {
    if (e.code === 'BAD_TITLE' || e.code === 'BAD_PARENT' || e.code === 'BAD_CATEGORY')
      return res.status(400).json({ error: 'Некорректные данные подкатегории' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// PUT /api/agent/service-subcategories/reorder { items:[{id, displayOrder}] }
// Объявлено ДО /:id, чтобы 'reorder' не поймался path-матчером как id.
router.put('/service-subcategories/reorder', adminOnly, async (req, res) => {
  try { res.json(await settings.reorderSubcategories(req.user.salonId, (req.body || {}).items)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// PUT /api/agent/service-subcategories/:id { title }
router.put('/service-subcategories/:id', adminOnly, async (req, res) => {
  try {
    res.json(await settings.renameSubcategory(
      req.user.salonId, parseInt(req.params.id, 10), (req.body || {}).title));
  } catch (e) {
    if (e.code === 'BAD_TITLE') return res.status(400).json({ error: 'Пустое название' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/agent/service-subcategories/:id
router.delete('/service-subcategories/:id', adminOnly, async (req, res) => {
  try {
    await settings.removeSubcategory(req.user.salonId, parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// POST /api/agent/service-placements { ycServiceId, subcategoryId } (пусто → снять)
router.post('/service-placements', adminOnly, async (req, res) => {
  try {
    const { ycServiceId, subcategoryId } = req.body || {};
    res.json(await settings.placeService(req.user.salonId, { ycServiceId, subcategoryId }));
  } catch (e) {
    if (e.code === 'BAD_SERVICE') return res.status(400).json({ error: 'Не указана услуга' });
    if (e.code === 'BAD_SUBCATEGORY') return res.status(400).json({ error: 'Неизвестная подкатегория' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/agent/service-placements/:ycServiceId
router.delete('/service-placements/:ycServiceId', adminOnly, async (req, res) => {
  try {
    await settings.unplaceService(req.user.salonId, parseInt(req.params.ycServiceId, 10));
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// ── Фото прайс-листа по узлам дерева услуг ──────────────────────────────────

// GET /api/agent/price-photos → { photos:[{id,ycCategoryId,subcategoryId,fileUrl,fileName,displayOrder}] }
router.get('/price-photos', adminOnly, async (req, res) => {
  try {
    const rows = await settings.listPricePhotos(req.user.salonId);
    res.json({
      photos: rows.map(r => ({
        id: r.id,
        ycCategoryId: r.yc_category_id == null ? null : String(r.yc_category_id),
        subcategoryId: r.subcategory_id,
        fileUrl: r.file_url,
        fileName: r.file_name,
        displayOrder: r.display_order,
      })),
    });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// POST /api/agent/price-photos — multipart: file + ycCategoryId | subcategoryId
// Multer навешан вручную (не как обычный middleware): нужно поймать её ошибки
// (не-картинка, файл > 5 МБ) самим и вернуть внятный 400, а не голый 500
// Express (см. тот же приём в routes/portfolio.js POST /categories/:id/cover).
router.post('/price-photos', adminOnly, (req, res) => {
  priceUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран или формат не поддерживается (JPEG, PNG, WEBP)' });

    // Узел дерева ОБЯЗАН быть проверенным числом ДО того, как попадёт в имя
    // файла на диске — сырую строку из тела запроса (`../../../tmp/evil`)
    // в fs.writeFileSync пускать нельзя, это выход за пределы uploads/.
    const rawCat = (req.body || {}).ycCategoryId;
    const rawSub = (req.body || {}).subcategoryId;
    const cat = rawCat == null || rawCat === '' ? null : Number(rawCat);
    const sub = rawSub == null || rawSub === '' ? null : Number(rawSub);
    const catOk = cat == null || Number.isInteger(cat);
    const subOk = sub == null || Number.isInteger(sub);
    if (!catOk || !subOk || (cat == null) === (sub == null)) {
      return res.status(400).json({ error: 'Не указана категория или подкатегория' });
    }

    const node = sub != null ? `s${sub}` : `c${cat}`;
    const ext = (req.file.originalname.match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0];
    const fileName = `pricelist_${req.user.salonId}_${node}_${Date.now()}${ext}`;
    const fileUrl = `/uploads/${fileName}`;
    try {
      fs.writeFileSync(path.join(uploadsDir, fileName), req.file.buffer);
      try {
        const row = await settings.addPricePhoto(req.user.salonId, {
          ycCategoryId: cat, subcategoryId: sub, fileUrl, fileName,
          mimeType: req.file.mimetype, byteSize: req.file.size,
        });
        invalidatePriceIndex(req.user.salonId);
        res.json({ id: row.id, fileUrl });
      } catch (e) {
        safeUnlink(fileUrl);   // строка не легла — файл на диске не оставляем
        throw e;
      }
    } catch (e) {
      if (e.code === 'BAD_NODE') return res.status(400).json({ error: 'Не указана категория или подкатегория' });
      if (e.code === 'PHOTO_LIMIT') return res.status(400).json({ error: `Больше ${settings.MAX_PRICE_PHOTOS_PER_NODE} фото на один раздел загрузить нельзя` });
      logger.error(e.message); res.status(500).json({ error: 'server error' });
    }
  });
});

// PUT /api/agent/price-photos/reorder { items:[{id, displayOrder}] }
// Объявлено ДО /:id, чтобы 'reorder' не поймался path-матчером как id.
router.put('/price-photos/reorder', adminOnly, async (req, res) => {
  try {
    const out = await settings.reorderPricePhotos(req.user.salonId, (req.body || {}).items);
    invalidatePriceIndex(req.user.salonId);
    res.json(out);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// DELETE /api/agent/price-photos/:id
router.delete('/price-photos/:id', adminOnly, async (req, res) => {
  try {
    const row = await settings.removePricePhoto(req.user.salonId, parseInt(req.params.id, 10));
    if (row) safeUnlink(row.file_url);
    invalidatePriceIndex(req.user.salonId);
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

module.exports = router;
