'use strict';

const router = require('express').Router();
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { validateReorderPayload } = require('../services/portfolio');
const {
  STARTER_CATEGORIES, validateArticleInput, normalizeTags,
} = require('../services/knowledge-base');
const { createLogger } = require('../logger');
const logger = createLogger('KnowledgeBase');

const readAny   = [auth];                              // читают все роли
const adminOnly = [auth, requireRole('owner', 'admin')];

// ── Categories ────────────────────────────────────────────────

// Создаёт стартовые папки, если у салона их ещё нет (idempotent).
async function seedIfEmpty(salonId) {
  const row = await db.one(
    `SELECT COUNT(*)::int AS n FROM kb_categories WHERE salon_id=$1`, [salonId]);
  if (row.n > 0) return;
  for (const c of STARTER_CATEGORIES) {
    await db.query(
      `INSERT INTO kb_categories (salon_id, title, icon, display_order)
       VALUES ($1,$2,$3,$4)`,
      [salonId, c.title, c.icon, c.display_order]);
  }
  logger.info(`seeded ${STARTER_CATEGORIES.length} categories for salon ${salonId}`);
}

// GET /api/kb/categories — папки с числом опубликованных статей
router.get('/categories', readAny, async (req, res) => {
  try {
    await seedIfEmpty(req.user.salonId);
    const rows = await db.any(
      `SELECT c.id, c.title, c.icon, c.display_order,
              (SELECT COUNT(*) FROM kb_articles a
                WHERE a.salon_id=c.salon_id AND a.category_id=c.id
                  AND a.is_published=true) AS articles_count
         FROM kb_categories c
        WHERE c.salon_id=$1
        ORDER BY c.display_order ASC, c.id ASC`,
      [req.user.salonId]);
    res.json({ categories: rows });
  } catch (e) {
    logger.error(`GET /categories: ${e.message}`);
    res.status(500).json({ error: 'Ошибка загрузки категорий' });
  }
});

// PUT /api/kb/categories/reorder — батч display_order (ДО /:id!)
router.put('/categories/reorder', adminOnly, async (req, res) => {
  const { order } = req.body || {};
  const v = validateReorderPayload(order);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    for (const { id, display_order } of order) {
      await db.query(
        `UPDATE kb_categories SET display_order=$1, updated_at=now()
          WHERE id=$2 AND salon_id=$3`,
        [display_order, id, req.user.salonId]);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error(`PUT /categories/reorder: ${e.message}`);
    res.status(500).json({ error: 'Ошибка сортировки' });
  }
});

// POST /api/kb/categories — создать папку
router.post('/categories', adminOnly, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const icon  = (req.body?.icon  || '').trim();
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  try {
    const next = await db.one(
      `SELECT COALESCE(MAX(display_order),0)+1 AS next
         FROM kb_categories WHERE salon_id=$1`, [req.user.salonId]);
    const row = await db.one(
      `INSERT INTO kb_categories (salon_id, title, icon, display_order)
       VALUES ($1,$2,$3,$4) RETURNING id, title, icon, display_order`,
      [req.user.salonId, title, icon, next.next]);
    res.json({ category: row });
  } catch (e) {
    logger.error(`POST /categories: ${e.message}`);
    res.status(500).json({ error: 'Ошибка создания папки' });
  }
});

// PUT /api/kb/categories/:id — переименовать/сменить иконку
router.put('/categories/:id', adminOnly, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const icon  = (req.body?.icon  || '').trim();
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  try {
    const row = await db.oneOrNone(
      `UPDATE kb_categories SET title=$1, icon=$2, updated_at=now()
        WHERE id=$3 AND salon_id=$4
        RETURNING id, title, icon, display_order`,
      [title, icon, req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    res.json({ category: row });
  } catch (e) {
    logger.error(`PUT /categories/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка обновления папки' });
  }
});

// DELETE /api/kb/categories/:id — удалить папку (каскадом статьи)
router.delete('/categories/:id', adminOnly, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `DELETE FROM kb_categories WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    res.json({ ok: true });
  } catch (e) {
    logger.error(`DELETE /categories/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка удаления папки' });
  }
});

module.exports = router;
