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

// ── Items ─────────────────────────────────────────────────────

// GET /api/portfolio/categories/:id/items — list items in a category
router.get('/categories/:id/items', adminOnly, async (req, res) => {
  try {
    const catId = parseInt(req.params.id, 10);
    if (!catId) return res.status(400).json({ error: 'invalid id' });
    const cat = await db.oneOrNone(
      `SELECT id FROM portfolio_categories WHERE id=$1 AND salon_id=$2`,
      [catId, req.user.salonId]
    );
    if (!cat) return res.status(404).json({ error: 'Категория не найдена' });

    const rows = await db.any(
      `SELECT i.id, i.title, i.description, i.staff_id,
              i.photo_after_url, i.photo_before_url, i.display_order,
              s.name AS staff_name
       FROM portfolio_items i
       LEFT JOIN staff_members s ON s.id=i.staff_id
       WHERE i.salon_id=$1 AND i.category_id=$2
       ORDER BY i.display_order ASC, i.id ASC`,
      [req.user.salonId, catId]
    );
    res.json({
      items: rows.map(r => ({
        id: r.id,
        title: r.title,
        description: r.description,
        staffId: r.staff_id,
        staffName: r.staff_name,
        photoAfterUrl: r.photo_after_url,
        photoBeforeUrl: r.photo_before_url,
        displayOrder: r.display_order,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portfolio/items — create item with after-photo (and optional before)
router.post('/items', adminOnly, (req, res) => {
  upload.fields([
    { name: 'after',  maxCount: 1 },
    { name: 'before', maxCount: 1 },
  ])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const fAfter  = req.files?.after?.[0];
    const fBefore = req.files?.before?.[0];
    if (!fAfter) return res.status(400).json({ error: 'Фото "После" обязательно' });

    const categoryId = parseInt(req.body.category_id, 10);
    if (!categoryId) return res.status(400).json({ error: 'category_id required' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > 80) return res.status(400).json({ error: 'title too long (max 80)' });
    const description = (req.body.description != null) ? String(req.body.description).slice(0, 1000) : null;
    const staffId = req.body.staff_id ? parseInt(req.body.staff_id, 10) : null;

    // verify category belongs to salon
    const cat = await db.oneOrNone(
      `SELECT id FROM portfolio_categories WHERE id=$1 AND salon_id=$2`,
      [categoryId, req.user.salonId]
    );
    if (!cat) return res.status(404).json({ error: 'Категория не найдена' });

    // verify staff belongs to salon (if provided)
    if (staffId) {
      const st = await db.oneOrNone(
        `SELECT id FROM staff_members WHERE id=$1 AND salon_id=$2`,
        [staffId, req.user.salonId]
      );
      if (!st) return res.status(400).json({ error: 'Сотрудник не найден в салоне' });
    }

    // insert with placeholder URLs to get an id, then write files using the id
    const next = await db.one(
      `SELECT COALESCE(MAX(display_order)+1, 0) AS next_order
       FROM portfolio_items WHERE salon_id=$1 AND category_id=$2`,
      [req.user.salonId, categoryId]
    );
    const inserted = await db.one(
      `INSERT INTO portfolio_items
         (salon_id, category_id, staff_id, title, description,
          photo_after_url, photo_before_url, display_order)
       VALUES ($1,$2,$3,$4,$5,'','',$6) RETURNING id`,
      [req.user.salonId, categoryId, staffId, title, description, next.next_order]
    );

    // write files
    const ts = Date.now();
    const afterName  = buildPhotoFilename('item', inserted.id, 'after',  fAfter.originalname,  ts);
    const afterAbs   = path.join(uploadsDir, afterName);
    fs.writeFileSync(afterAbs, fAfter.buffer);
    const afterUrl = `/uploads/${afterName}`;

    let beforeUrl = null;
    if (fBefore) {
      const beforeName = buildPhotoFilename('item', inserted.id, 'before', fBefore.originalname, ts);
      const beforeAbs  = path.join(uploadsDir, beforeName);
      fs.writeFileSync(beforeAbs, fBefore.buffer);
      beforeUrl = `/uploads/${beforeName}`;
    }

    await db.query(
      `UPDATE portfolio_items
       SET photo_after_url=$1, photo_before_url=$2, updated_at=NOW()
       WHERE id=$3`,
      [afterUrl, beforeUrl, inserted.id]
    );

    res.json({ id: inserted.id, photoAfterUrl: afterUrl, photoBeforeUrl: beforeUrl });
  });
});

// PUT /api/portfolio/items/reorder — batch update display_order within one category
router.put('/items/reorder', adminOnly, async (req, res) => {
  try {
    const { order } = req.body;
    const v = validateReorderPayload(order);
    if (!v.valid) return res.status(400).json({ error: v.error });

    const ids = order.map(o => o.id);
    const rows = await db.any(
      `SELECT id, category_id FROM portfolio_items
       WHERE salon_id=$1 AND id=ANY($2::int[])`,
      [req.user.salonId, ids]
    );
    if (rows.length !== ids.length) {
      return res.status(400).json({ error: 'Some ids do not belong to your salon' });
    }
    const cats = new Set(rows.map(r => r.category_id));
    if (cats.size !== 1) {
      return res.status(400).json({ error: 'All items must belong to the same category' });
    }

    for (const { id, display_order } of order) {
      await db.query(
        `UPDATE portfolio_items SET display_order=$1, updated_at=NOW()
         WHERE id=$2 AND salon_id=$3`,
        [display_order, id, req.user.salonId]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/portfolio/items/:id — update text fields (no photos here)
router.put('/items/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const cur = await db.oneOrNone(
      `SELECT id, category_id FROM portfolio_items
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!cur) return res.status(404).json({ error: 'Запись не найдена' });

    const updates = []; const params = [];
    if (req.body.title !== undefined) {
      const title = String(req.body.title).trim();
      if (!title || title.length > 80) return res.status(400).json({ error: 'invalid title' });
      params.push(title); updates.push(`title=$${params.length}`);
    }
    if (req.body.description !== undefined) {
      const desc = req.body.description ? String(req.body.description).slice(0, 1000) : null;
      params.push(desc); updates.push(`description=$${params.length}`);
    }
    if (req.body.staffId !== undefined) {
      const staffId = req.body.staffId ? parseInt(req.body.staffId, 10) : null;
      if (staffId) {
        const st = await db.oneOrNone(
          `SELECT id FROM staff_members WHERE id=$1 AND salon_id=$2`,
          [staffId, req.user.salonId]
        );
        if (!st) return res.status(400).json({ error: 'Сотрудник не найден' });
      }
      params.push(staffId); updates.push(`staff_id=$${params.length}`);
    }
    if (req.body.categoryId !== undefined) {
      const newCat = parseInt(req.body.categoryId, 10);
      if (!newCat) return res.status(400).json({ error: 'invalid categoryId' });
      const c = await db.oneOrNone(
        `SELECT id FROM portfolio_categories WHERE id=$1 AND salon_id=$2`,
        [newCat, req.user.salonId]
      );
      if (!c) return res.status(404).json({ error: 'Категория не найдена' });
      params.push(newCat); updates.push(`category_id=$${params.length}`);
    }
    if (!updates.length) return res.json({ ok: true });
    updates.push(`updated_at=NOW()`);
    params.push(id, req.user.salonId);
    await db.query(
      `UPDATE portfolio_items SET ${updates.join(', ')}
       WHERE id=$${params.length - 1} AND salon_id=$${params.length}`,
      params
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/portfolio/items/:id/photos — replace one or both photos
router.post('/items/:id/photos', adminOnly, (req, res) => {
  upload.fields([
    { name: 'after',  maxCount: 1 },
    { name: 'before', maxCount: 1 },
  ])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const fAfter  = req.files?.after?.[0];
    const fBefore = req.files?.before?.[0];
    if (!fAfter && !fBefore) return res.status(400).json({ error: 'Файлы не получены' });

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const cur = await db.oneOrNone(
      `SELECT photo_after_url, photo_before_url FROM portfolio_items
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!cur) return res.status(404).json({ error: 'Запись не найдена' });

    const ts = Date.now();
    const updates = []; const params = [];
    let oldAfter = null, oldBefore = null;

    if (fAfter) {
      const name = buildPhotoFilename('item', id, 'after', fAfter.originalname, ts);
      fs.writeFileSync(path.join(uploadsDir, name), fAfter.buffer);
      params.push(`/uploads/${name}`); updates.push(`photo_after_url=$${params.length}`);
      oldAfter = cur.photo_after_url;
    }
    if (fBefore) {
      const name = buildPhotoFilename('item', id, 'before', fBefore.originalname, ts);
      fs.writeFileSync(path.join(uploadsDir, name), fBefore.buffer);
      params.push(`/uploads/${name}`); updates.push(`photo_before_url=$${params.length}`);
      oldBefore = cur.photo_before_url;
    }
    updates.push(`updated_at=NOW()`);
    params.push(id, req.user.salonId);
    await db.query(
      `UPDATE portfolio_items SET ${updates.join(', ')}
       WHERE id=$${params.length - 1} AND salon_id=$${params.length}`,
      params
    );

    safeUnlink(oldAfter);
    safeUnlink(oldBefore);

    const fresh = await db.one(
      `SELECT photo_after_url, photo_before_url FROM portfolio_items WHERE id=$1`, [id]
    );
    res.json({ photoAfterUrl: fresh.photo_after_url, photoBeforeUrl: fresh.photo_before_url });
  });
});

// DELETE /api/portfolio/items/:id/before — clear before-photo only
router.delete('/items/:id/before', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const cur = await db.oneOrNone(
      `SELECT photo_before_url FROM portfolio_items
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!cur) return res.status(404).json({ error: 'Запись не найдена' });

    await db.query(
      `UPDATE portfolio_items SET photo_before_url=NULL, updated_at=NOW()
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    safeUnlink(cur.photo_before_url);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/portfolio/items/:id — delete row + both files
router.delete('/items/:id', adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const cur = await db.oneOrNone(
      `SELECT photo_after_url, photo_before_url FROM portfolio_items
       WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!cur) return res.status(404).json({ error: 'Запись не найдена' });
    await db.query(
      `DELETE FROM portfolio_items WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    safeUnlink(cur.photo_after_url);
    safeUnlink(cur.photo_before_url);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
