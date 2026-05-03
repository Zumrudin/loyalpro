'use strict';

const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { buildPhotoFilename, validateReorderPayload } = require('../services/portfolio');
const { createLogger } = require('../logger');
const logger = createLogger('Portfolio');

const adminOnly = [auth, requireRole('owner', 'admin')];

// ── multer storage (shared by all upload endpoints) ───────────
const uploadsDir = path.join(__dirname, '../../frontend/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(), // we set the final filename ourselves
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Только изображения'));
  },
});

function safeUnlink(relUrl) {
  if (!relUrl || !relUrl.startsWith('/uploads/')) return;
  const abs = path.join(uploadsDir, path.basename(relUrl));
  fs.unlink(abs, (err) => {
    if (err && err.code !== 'ENOENT') logger.warn(`unlink ${abs}: ${err.message}`);
  });
}

// ── Categories ────────────────────────────────────────────────

// GET /api/portfolio/categories — list with items_count
router.get('/categories', adminOnly, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT c.id, c.title, c.cover_photo_url, c.display_order, c.is_published,
              (SELECT COUNT(*)::int FROM portfolio_items i
               WHERE i.salon_id=c.salon_id AND i.category_id=c.id) AS items_count
       FROM portfolio_categories c
       WHERE c.salon_id=$1
       ORDER BY c.display_order ASC, c.id ASC`,
      [req.user.salonId]
    );
    res.json({
      categories: rows.map(r => ({
        id: r.id,
        title: r.title,
        coverPhotoUrl: r.cover_photo_url || null,
        displayOrder: r.display_order,
        isPublished: r.is_published,
        itemsCount: r.items_count,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portfolio/categories — create with empty cover (sentinel)
router.post('/categories', adminOnly, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > 120) return res.status(400).json({ error: 'title too long (max 120)' });

    const next = await db.one(
      `SELECT COALESCE(MAX(display_order)+1, 0) AS next_order
       FROM portfolio_categories WHERE salon_id=$1`,
      [req.user.salonId]
    );
    const row = await db.one(
      `INSERT INTO portfolio_categories (salon_id, title, display_order)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.user.salonId, title, next.next_order]
    );
    res.json({ id: row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/portfolio/categories/reorder — batch update display_order
router.put('/categories/reorder', adminOnly, async (req, res) => {
  try {
    const { order } = req.body;
    const v = validateReorderPayload(order);
    if (!v.valid) return res.status(400).json({ error: v.error });

    // verify all ids belong to this salon
    const ids = order.map(o => o.id);
    const owned = await db.any(
      `SELECT id FROM portfolio_categories
       WHERE salon_id=$1 AND id=ANY($2::int[])`,
      [req.user.salonId, ids]
    );
    if (owned.length !== ids.length) {
      return res.status(400).json({ error: 'Some ids do not belong to your salon' });
    }

    for (const { id, display_order } of order) {
      await db.query(
        `UPDATE portfolio_categories SET display_order=$1, updated_at=NOW()
         WHERE id=$2 AND salon_id=$3`,
        [display_order, id, req.user.salonId]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/portfolio/categories/:id — update title and/or is_published
router.put('/categories/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const cat = await db.oneOrNone(
      `SELECT id, cover_photo_url FROM portfolio_categories
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!cat) return res.status(404).json({ error: 'Категория не найдена' });

    const updates = [];
    const params = [];
    if (req.body.title !== undefined) {
      const title = String(req.body.title).trim();
      if (!title || title.length > 120) return res.status(400).json({ error: 'invalid title' });
      params.push(title); updates.push(`title=$${params.length}`);
    }
    if (req.body.isPublished !== undefined) {
      const wantPublish = !!req.body.isPublished;
      if (wantPublish && !cat.cover_photo_url) {
        return res.status(400).json({ error: 'Нельзя опубликовать категорию без обложки' });
      }
      params.push(wantPublish); updates.push(`is_published=$${params.length}`);
    }
    if (!updates.length) return res.json({ ok: true });
    updates.push(`updated_at=NOW()`);
    params.push(id, req.user.salonId);
    await db.query(
      `UPDATE portfolio_categories SET ${updates.join(', ')}
       WHERE id=$${params.length - 1} AND salon_id=$${params.length}`,
      params
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/portfolio/categories/:id — cascade items, remove all files
router.delete('/categories/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    // collect file paths before delete
    const cat = await db.oneOrNone(
      `SELECT cover_photo_url FROM portfolio_categories
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!cat) return res.status(404).json({ error: 'Категория не найдена' });
    const items = await db.any(
      `SELECT photo_after_url, photo_before_url FROM portfolio_items
       WHERE category_id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );

    await db.query(
      `DELETE FROM portfolio_categories WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );

    safeUnlink(cat.cover_photo_url);
    for (const it of items) {
      safeUnlink(it.photo_after_url);
      safeUnlink(it.photo_before_url);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portfolio/categories/:id/cover — upload/replace category cover
router.post('/categories/:id/cover', adminOnly, (req, res) => {
  upload.single('photo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const cat = await db.oneOrNone(
      `SELECT cover_photo_url FROM portfolio_categories
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!cat) return res.status(404).json({ error: 'Категория не найдена' });

    const filename = buildPhotoFilename('category', id, null, req.file.originalname, Date.now());
    const absPath = path.join(uploadsDir, filename);
    try {
      fs.writeFileSync(absPath, req.file.buffer);
    } catch (e) {
      return res.status(500).json({ error: 'Ошибка записи файла: ' + e.message });
    }
    const url = `/uploads/${filename}`;

    try {
      await db.query(
        `UPDATE portfolio_categories
         SET cover_photo_url=$1, updated_at=NOW()
         WHERE id=$2 AND salon_id=$3`,
        [url, id, req.user.salonId]
      );
    } catch (e) {
      // rollback: remove just-written file
      try { fs.unlinkSync(absPath); } catch (_) {}
      return res.status(500).json({ error: e.message });
    }

    safeUnlink(cat.cover_photo_url); // remove old file (no-op if sentinel '')
    res.json({ ok: true, url });
  });
});

module.exports = router;
