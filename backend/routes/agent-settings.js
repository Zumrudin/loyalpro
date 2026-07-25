'use strict';
// ============================================================
// Agent settings API — управление ИИ-агентом из админки (owner/admin).
// Тумблер вкл/выкл, режим допуска (all|whitelist), белый/чёрный списки номеров.
// ============================================================
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const settings = require('../services/agent-settings');
const { createLogger } = require('../logger');
const logger = createLogger('AgentSettings');

const adminOnly = [auth, requireRole('owner', 'admin')];

// GET /api/agent/settings → { enabled, mode }
router.get('/settings', adminOnly, async (req, res) => {
  try { res.json(await settings.getSettings(req.user.salonId)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// PUT /api/agent/settings { enabled, mode }
router.put('/settings', adminOnly, async (req, res) => {
  try {
    const { enabled, mode } = req.body || {};
    res.json(await settings.updateSettings(req.user.salonId, { enabled, mode }));
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
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

module.exports = router;
