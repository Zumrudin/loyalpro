# Portfolio (До/После) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "before/after" portfolio module to LoyalPro: admin-side gallery management under Settings → Mobile App, plus mobile API endpoints for the client app to consume.

**Architecture:** Two new PostgreSQL tables (`portfolio_categories`, `portfolio_items`) scoped by `salon_id`. Admin REST API at `/api/portfolio` reuses multer disk-upload pattern from `routes/staff.js`. Mobile API extends `routes/mobile-client.js` with three GETs. Pure helpers extracted to `services/portfolio.js` for unit testing. Frontend adds new SPA page `frontend/js/pages/portfolio.js` mounted in the existing settings menu.

**Tech Stack:** Node.js 18 + Express 4, PostgreSQL via `pg` pool (no ORM), multer 2.x, Jest 30 for unit tests, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-05-03-portfolio-before-after-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/migrations.js` | Modify (append) | Add `CREATE TABLE IF NOT EXISTS` for both portfolio tables + indexes |
| `backend/services/portfolio.js` | Create | Pure helpers: filename generation, reorder validation, URL absolutization |
| `backend/portfolio.test.js` | Create | Jest unit tests for `services/portfolio.js` |
| `backend/routes/portfolio.js` | Create | Admin REST API (categories + items CRUD + uploads + reorder) |
| `backend/routes/index.js` | Modify | Mount `/api/portfolio` after `/api/app-settings` |
| `backend/routes/mobile-client.js` | Modify (append) | Add 3 mobile GETs: categories list, single category, by-staff |
| `frontend/index.html` | Modify | Add menu item, settings section container, item modal, category modal, script tag |
| `frontend/js/pages/portfolio.js` | Create | Admin SPA: two-level navigation, drag-drop reorder, modals |

Boundaries chosen so each file has one clear responsibility:
- `services/portfolio.js` is pure (no DB, no HTTP) → trivially unit-testable
- `routes/portfolio.js` is the only file with multer + DB writes for admin CRUD
- Mobile endpoints sit alongside other mobile endpoints in `mobile-client.js` (project convention)
- Frontend logic isolated in its own file (per project's incremental JS-by-page split)

---

## Task 1: Database migrations

**Files:**
- Modify: `backend/migrations.js` (append new section near the bottom, before `module.exports`)

- [ ] **Step 1: Read current migrations.js bottom**

Open [backend/migrations.js](backend/migrations.js). Find the line `module.exports = { runMigrations };` — new SQL goes immediately above it.

- [ ] **Step 2: Append both tables and indexes**

Add this block above `module.exports`:

```js
  // ── Portfolio (До/После) tables ─────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS portfolio_categories (
      id              SERIAL PRIMARY KEY,
      salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      title           VARCHAR(120) NOT NULL,
      cover_photo_url TEXT NOT NULL DEFAULT '',
      display_order   INTEGER NOT NULL DEFAULT 0,
      is_published    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_categories_salon_order
      ON portfolio_categories (salon_id, display_order)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS portfolio_items (
      id                SERIAL PRIMARY KEY,
      salon_id          INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      category_id       INTEGER NOT NULL REFERENCES portfolio_categories(id) ON DELETE CASCADE,
      staff_id          INTEGER REFERENCES staff_members(id) ON DELETE SET NULL,
      title             VARCHAR(80) NOT NULL,
      description       VARCHAR(1000),
      photo_after_url   TEXT NOT NULL,
      photo_before_url  TEXT,
      display_order     INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_items_category_order
      ON portfolio_items (salon_id, category_id, display_order)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_items_staff
      ON portfolio_items (salon_id, staff_id) WHERE staff_id IS NOT NULL
  `).catch(() => {});
```

Note: `cover_photo_url` has `DEFAULT ''` so we can `INSERT` rows from admin UI before the cover file is uploaded (sentinel-empty state). Publishing is gated separately in the API layer.

- [ ] **Step 3: Restart dev server to apply migration**

```bash
cd /root/loyalpro/backend && npm run dev
```

Watch logs for migration errors. The server logs `Migrations OK` on success.

- [ ] **Step 4: Verify schema via MCP postgres**

Use `mcp__postgres__query` with:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name IN ('portfolio_categories', 'portfolio_items')
ORDER BY table_name, ordinal_position;
```

Expected: 8 columns for `portfolio_categories`, 11 columns for `portfolio_items`. Confirm `cover_photo_url` has default `''::text` and is `NOT NULL`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/migrations.js
git commit -m "feat(portfolio): add DB schema for before/after gallery

Two new tables scoped by salon_id: portfolio_categories (with required
cover photo, display order, publish flag) and portfolio_items (with
required after-photo, optional before-photo, optional staff link).
Indexes on (salon_id, display_order) and partial index on staff_id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure helpers in services/portfolio.js

**Files:**
- Create: `backend/services/portfolio.js`
- Test: `backend/portfolio.test.js`

- [ ] **Step 1: Write failing tests first**

Create [backend/portfolio.test.js](backend/portfolio.test.js):

```js
'use strict';

const {
  buildPhotoFilename,
  validateReorderPayload,
  absolutizeUrl,
} = require('./services/portfolio');

describe('buildPhotoFilename', () => {
  test('category cover filename', () => {
    const name = buildPhotoFilename('category', 12, null, 'photo.JPG', 1714000000000);
    expect(name).toBe('portfolio_cat_12_1714000000000.jpg');
  });

  test('item after-photo filename', () => {
    const name = buildPhotoFilename('item', 45, 'after', 'IMG_1234.png', 1714000000000);
    expect(name).toBe('portfolio_item_45_after_1714000000000.png');
  });

  test('item before-photo filename', () => {
    const name = buildPhotoFilename('item', 45, 'before', 'x.webp', 1714000000000);
    expect(name).toBe('portfolio_item_45_before_1714000000000.webp');
  });

  test('falls back to .jpg if no extension', () => {
    const name = buildPhotoFilename('category', 1, null, 'noext', 1);
    expect(name).toBe('portfolio_cat_1_1.jpg');
  });

  test('rejects unknown kind for item', () => {
    expect(() => buildPhotoFilename('item', 1, 'middle', 'x.jpg', 1))
      .toThrow(/kind/);
  });
});

describe('validateReorderPayload', () => {
  test('valid payload', () => {
    const r = validateReorderPayload([{ id: 1, display_order: 0 }, { id: 2, display_order: 1 }]);
    expect(r.valid).toBe(true);
  });

  test('rejects empty array', () => {
    expect(validateReorderPayload([]).valid).toBe(false);
  });

  test('rejects non-array', () => {
    expect(validateReorderPayload({}).valid).toBe(false);
    expect(validateReorderPayload(null).valid).toBe(false);
  });

  test('rejects entries with non-integer id', () => {
    expect(validateReorderPayload([{ id: 'x', display_order: 0 }]).valid).toBe(false);
  });

  test('rejects entries with non-integer display_order', () => {
    expect(validateReorderPayload([{ id: 1, display_order: 'a' }]).valid).toBe(false);
  });

  test('rejects duplicate ids', () => {
    expect(validateReorderPayload([{ id: 1, display_order: 0 }, { id: 1, display_order: 1 }]).valid).toBe(false);
  });
});

describe('absolutizeUrl', () => {
  test('returns null for null/empty', () => {
    expect(absolutizeUrl('https://api.test', null)).toBeNull();
    expect(absolutizeUrl('https://api.test', '')).toBeNull();
  });

  test('passes through absolute http/https', () => {
    expect(absolutizeUrl('https://api.test', 'http://x/y')).toBe('http://x/y');
    expect(absolutizeUrl('https://api.test', 'https://x/y')).toBe('https://x/y');
  });

  test('prepends base for relative', () => {
    expect(absolutizeUrl('https://api.test', '/uploads/a.jpg')).toBe('https://api.test/uploads/a.jpg');
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
cd /root/loyalpro/backend && npx jest portfolio.test.js
```

Expected: FAIL with `Cannot find module './services/portfolio'`.

- [ ] **Step 3: Create services/portfolio.js with minimal implementation**

Create [backend/services/portfolio.js](backend/services/portfolio.js):

```js
'use strict';

const path = require('path');

const ALLOWED_KINDS = new Set(['after', 'before']);

/**
 * Build a uploads filename for portfolio media.
 * @param {'category'|'item'} entity
 * @param {number} entityId
 * @param {'after'|'before'|null} kind  required when entity='item', ignored for 'category'
 * @param {string} originalName  user-supplied filename, used only for extension
 * @param {number} timestamp     Date.now()
 */
function buildPhotoFilename(entity, entityId, kind, originalName, timestamp) {
  const ext = (path.extname(originalName || '').toLowerCase() || '.jpg');
  if (entity === 'category') {
    return `portfolio_cat_${entityId}_${timestamp}${ext}`;
  }
  if (entity === 'item') {
    if (!ALLOWED_KINDS.has(kind)) {
      throw new Error(`Invalid kind for item: ${kind}`);
    }
    return `portfolio_item_${entityId}_${kind}_${timestamp}${ext}`;
  }
  throw new Error(`Unknown entity: ${entity}`);
}

/**
 * Validate a reorder payload: array of {id, display_order} with integer values
 * and unique ids. Used by both categories/reorder and items/reorder.
 * @returns {{ valid: boolean, error?: string }}
 */
function validateReorderPayload(order) {
  if (!Array.isArray(order) || order.length === 0) {
    return { valid: false, error: 'order must be a non-empty array' };
  }
  const seen = new Set();
  for (const entry of order) {
    if (!entry || !Number.isInteger(entry.id) || !Number.isInteger(entry.display_order)) {
      return { valid: false, error: 'each entry needs integer id and display_order' };
    }
    if (seen.has(entry.id)) {
      return { valid: false, error: `duplicate id: ${entry.id}` };
    }
    seen.add(entry.id);
  }
  return { valid: true };
}

/**
 * Convert a relative `/uploads/x.jpg` to an absolute URL using the request base.
 * Already-absolute URLs are passed through unchanged. Empty/null returns null.
 */
function absolutizeUrl(baseUrl, url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl}${url}`;
}

module.exports = { buildPhotoFilename, validateReorderPayload, absolutizeUrl };
```

- [ ] **Step 4: Run tests, expect pass**

```bash
cd /root/loyalpro/backend && npx jest portfolio.test.js
```

Expected: 14 tests pass (3 describe blocks).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/services/portfolio.js backend/portfolio.test.js
git commit -m "feat(portfolio): pure helpers for filenames, reorder validation, URL absolutize

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Admin route — categories CRUD (no uploads yet)

**Files:**
- Create: `backend/routes/portfolio.js`
- Modify: `backend/routes/index.js` (mount the route)

- [ ] **Step 1: Create skeleton with categories list/create/update/delete**

Create [backend/routes/portfolio.js](backend/routes/portfolio.js):

```js
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

module.exports = router;
```

- [ ] **Step 2: Mount route in index.js**

Open [backend/routes/index.js](backend/routes/index.js). Find the line:

```js
  app.use('/api/app-settings',      require('./app-settings'));
```

Add immediately below it:

```js
  app.use('/api/portfolio',         require('./portfolio'));
```

- [ ] **Step 3: Restart dev server**

```bash
cd /root/loyalpro/backend && pm2 restart loyalpro || npm run dev
```

(If using `npm run dev`, the nodemon will reload automatically.)

- [ ] **Step 4: Smoke test categories CRUD**

Get an admin JWT first (existing helper or login flow). Set `TOK` to your JWT, then:

```bash
TOK="<your-admin-jwt>"
BASE="http://localhost:3001"

# Create
curl -s -X POST "$BASE/api/portfolio/categories" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"title":"Тестовая категория"}'
# Expected: {"id":1}

# List
curl -s "$BASE/api/portfolio/categories" -H "Authorization: Bearer $TOK"
# Expected: {"categories":[{"id":1,"title":"Тестовая категория","coverPhotoUrl":null,"displayOrder":0,"isPublished":true,"itemsCount":0}]}

# Try to publish without cover (should fail; default is_published=true was set on insert,
# but the validation kicks in only on explicit PUT — so this PUT must fail)
curl -s -X PUT "$BASE/api/portfolio/categories/1" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"isPublished":true}'
# Expected: {"error":"Нельзя опубликовать категорию без обложки"}

# Update title
curl -s -X PUT "$BASE/api/portfolio/categories/1" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"title":"Маникюр"}'
# Expected: {"ok":true}

# Delete
curl -s -X DELETE "$BASE/api/portfolio/categories/1" -H "Authorization: Bearer $TOK"
# Expected: {"ok":true}
```

If any step fails, fix the route and retry. Do not proceed until all four work.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/routes/portfolio.js backend/routes/index.js
git commit -m "feat(portfolio): admin API for categories CRUD (no upload yet)

GET/POST/PUT/DELETE /api/portfolio/categories with publish gating
(cannot publish without cover) and cascade file cleanup on delete.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Cover upload + categories reorder

**Files:**
- Modify: `backend/routes/portfolio.js`

- [ ] **Step 1: Add cover upload and reorder endpoints**

Open `backend/routes/portfolio.js`. Add these handlers above `module.exports`:

```js
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
```

Note: route order matters in Express. `/categories/reorder` is defined AFTER `/categories/:id` in the file, but since `:id` is matched as `parseInt('reorder', 10) = NaN`, the `/categories/:id` handler returns 400 invalid id before reaching `/categories/reorder`. To avoid this, declare `/categories/reorder` BEFORE the `:id`-style handlers.

Move the new `router.put('/categories/reorder', ...)` block ABOVE the existing `router.put('/categories/:id', ...)` block in the file.

- [ ] **Step 2: Restart server, smoke test cover + reorder**

```bash
cd /root/loyalpro/backend && pm2 restart loyalpro || true

TOK="<your-admin-jwt>"
BASE="http://localhost:3001"

# Create two categories
ID1=$(curl -s -X POST "$BASE/api/portfolio/categories" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"title":"A"}' | jq -r .id)
ID2=$(curl -s -X POST "$BASE/api/portfolio/categories" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"title":"B"}' | jq -r .id)

# Upload cover for ID1 (need any small jpeg on disk)
curl -s -X POST "$BASE/api/portfolio/categories/$ID1/cover" \
  -H "Authorization: Bearer $TOK" \
  -F "photo=@/tmp/sample.jpg"
# Expected: {"ok":true,"url":"/uploads/portfolio_cat_<id>_<ts>.jpg"}

# Now publishing should succeed
curl -s -X PUT "$BASE/api/portfolio/categories/$ID1" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"isPublished":true}'
# Expected: {"ok":true}

# Reorder: swap them
curl -s -X PUT "$BASE/api/portfolio/categories/reorder" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"order\":[{\"id\":$ID2,\"display_order\":0},{\"id\":$ID1,\"display_order\":1}]}"
# Expected: {"ok":true}

# Verify order via list
curl -s "$BASE/api/portfolio/categories" -H "Authorization: Bearer $TOK" | jq '.categories[].id'
# Expected: ID2 first, then ID1

# Verify file exists on disk
ls /root/loyalpro/frontend/uploads/portfolio_cat_${ID1}_*.jpg

# Cleanup
curl -s -X DELETE "$BASE/api/portfolio/categories/$ID1" -H "Authorization: Bearer $TOK"
curl -s -X DELETE "$BASE/api/portfolio/categories/$ID2" -H "Authorization: Bearer $TOK"
```

If you don't have `/tmp/sample.jpg`, generate one: `convert -size 200x200 xc:gray /tmp/sample.jpg` (ImageMagick) or copy any small jpeg.

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add backend/routes/portfolio.js
git commit -m "feat(portfolio): cover upload and category reorder

POST /api/portfolio/categories/:id/cover handles multipart upload to
frontend/uploads/, replaces old file on disk. PUT /categories/reorder
validates ownership and applies display_order in batch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Items CRUD with photo upload

**Files:**
- Modify: `backend/routes/portfolio.js`

- [ ] **Step 1: Add items endpoints**

Open `backend/routes/portfolio.js`. Add the following handlers above `module.exports`:

```js
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
```

- [ ] **Step 2: Restart and smoke-test items**

```bash
cd /root/loyalpro/backend && pm2 restart loyalpro || true

TOK="<your-admin-jwt>"
BASE="http://localhost:3001"

# Create category and upload cover
CID=$(curl -s -X POST "$BASE/api/portfolio/categories" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"title":"Маникюр"}' | jq -r .id)
curl -s -X POST "$BASE/api/portfolio/categories/$CID/cover" \
  -H "Authorization: Bearer $TOK" -F "photo=@/tmp/sample.jpg" >/dev/null

# Create item with both photos
IID=$(curl -s -X POST "$BASE/api/portfolio/items" \
  -H "Authorization: Bearer $TOK" \
  -F "category_id=$CID" -F "title=Френч" -F "description=Покрытие гель-лак" \
  -F "after=@/tmp/sample.jpg" -F "before=@/tmp/sample.jpg" | jq -r .id)
echo "Created item $IID"

# List items
curl -s "$BASE/api/portfolio/categories/$CID/items" -H "Authorization: Bearer $TOK" | jq
# Expected: items[0] has photoAfterUrl and photoBeforeUrl set, staffId=null

# Update title
curl -s -X PUT "$BASE/api/portfolio/items/$IID" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"title":"Френч с дизайном"}'

# Drop before-photo
curl -s -X DELETE "$BASE/api/portfolio/items/$IID/before" -H "Authorization: Bearer $TOK"
# Verify
curl -s "$BASE/api/portfolio/categories/$CID/items" -H "Authorization: Bearer $TOK" | jq '.items[0].photoBeforeUrl'
# Expected: null

# Replace after-photo
curl -s -X POST "$BASE/api/portfolio/items/$IID/photos" \
  -H "Authorization: Bearer $TOK" -F "after=@/tmp/sample.jpg"

# Cleanup
curl -s -X DELETE "$BASE/api/portfolio/items/$IID" -H "Authorization: Bearer $TOK"
curl -s -X DELETE "$BASE/api/portfolio/categories/$CID" -H "Authorization: Bearer $TOK"
```

Verify no `portfolio_*` files remain in `/root/loyalpro/frontend/uploads/`:

```bash
ls /root/loyalpro/frontend/uploads/ | grep '^portfolio_' || echo "Clean."
# Expected: "Clean."
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add backend/routes/portfolio.js
git commit -m "feat(portfolio): items CRUD with photo upload

POST /items handles multipart with after (req) + before (opt). Photo replace
via POST /items/:id/photos, before-only deletion via DELETE /items/:id/before.
File cleanup on every replace and on item/category cascade delete.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Items reorder

**Files:**
- Modify: `backend/routes/portfolio.js`

- [ ] **Step 1: Add reorder endpoint with same-category guard**

Open `backend/routes/portfolio.js`. Add this handler — placement: BEFORE the `router.put('/items/:id', ...)` block, to avoid the `:id` matcher swallowing `reorder`:

```js
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
```

- [ ] **Step 2: Smoke test**

```bash
cd /root/loyalpro/backend && pm2 restart loyalpro || true
TOK="<your-admin-jwt>" ; BASE="http://localhost:3001"

# Create category + 2 items
CID=$(curl -s -X POST "$BASE/api/portfolio/categories" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"title":"X"}' | jq -r .id)
curl -s -X POST "$BASE/api/portfolio/categories/$CID/cover" -H "Authorization: Bearer $TOK" -F "photo=@/tmp/sample.jpg" >/dev/null
I1=$(curl -s -X POST "$BASE/api/portfolio/items" -H "Authorization: Bearer $TOK" -F "category_id=$CID" -F "title=A" -F "after=@/tmp/sample.jpg" | jq -r .id)
I2=$(curl -s -X POST "$BASE/api/portfolio/items" -H "Authorization: Bearer $TOK" -F "category_id=$CID" -F "title=B" -F "after=@/tmp/sample.jpg" | jq -r .id)

# Swap order
curl -s -X PUT "$BASE/api/portfolio/items/reorder" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"order\":[{\"id\":$I2,\"display_order\":0},{\"id\":$I1,\"display_order\":1}]}"
# Expected: {"ok":true}

# Verify list ordering
curl -s "$BASE/api/portfolio/categories/$CID/items" -H "Authorization: Bearer $TOK" | jq '.items[].id'
# Expected: I2 first, then I1

# Negative test: cross-category should reject
CID2=$(curl -s -X POST "$BASE/api/portfolio/categories" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"title":"Y"}' | jq -r .id)
curl -s -X POST "$BASE/api/portfolio/categories/$CID2/cover" -H "Authorization: Bearer $TOK" -F "photo=@/tmp/sample.jpg" >/dev/null
I3=$(curl -s -X POST "$BASE/api/portfolio/items" -H "Authorization: Bearer $TOK" -F "category_id=$CID2" -F "title=C" -F "after=@/tmp/sample.jpg" | jq -r .id)
curl -s -X PUT "$BASE/api/portfolio/items/reorder" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"order\":[{\"id\":$I1,\"display_order\":0},{\"id\":$I3,\"display_order\":1}]}"
# Expected: {"error":"All items must belong to the same category"}

# Cleanup
curl -s -X DELETE "$BASE/api/portfolio/categories/$CID" -H "Authorization: Bearer $TOK" >/dev/null
curl -s -X DELETE "$BASE/api/portfolio/categories/$CID2" -H "Authorization: Bearer $TOK" >/dev/null
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add backend/routes/portfolio.js
git commit -m "feat(portfolio): items reorder with same-category guard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Mobile API — categories list

**Files:**
- Modify: `backend/routes/mobile-client.js` (append handlers)

- [ ] **Step 1: Add import + handler**

Open [backend/routes/mobile-client.js](backend/routes/mobile-client.js).

Find the line:
```js
const { mobileAuth } = require('../middleware/mobile-auth');
```

Add immediately below it:
```js
const { absolutizeUrl } = require('../services/portfolio');
```

Then add this handler ABOVE `module.exports = router;`:

```js
// GET /api/mobile/client/portfolio/categories
// Returns published, non-empty categories scoped to client's salon
router.get('/portfolio/categories', mobileAuth, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const rows = await db.any(
      `SELECT c.id, c.title, c.cover_photo_url,
              (SELECT COUNT(*)::int FROM portfolio_items i
               WHERE i.salon_id=c.salon_id AND i.category_id=c.id) AS items_count
       FROM portfolio_categories c
       WHERE c.salon_id = (SELECT salon_id FROM clients WHERE id=$1)
         AND c.is_published = TRUE
         AND c.cover_photo_url <> ''
       ORDER BY c.display_order ASC, c.id ASC`,
      [req.client.clientId]
    );
    const categories = rows
      .filter(r => r.items_count > 0)
      .map(r => ({
        id: r.id,
        title: r.title,
        coverPhotoUrl: absolutizeUrl(baseUrl, r.cover_photo_url),
        itemsCount: r.items_count,
      }));
    res.json({ success: true, categories });
  } catch (e) {
    logger.error(`Get portfolio categories error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Smoke test**

You'll need a mobile JWT (a `type: 'client'` token). Existing scripts under `backend/test-auth-integration.js` show how to mint one for development.

```bash
TOK="<mobile-client-jwt>"
BASE="http://localhost:3001"

# Need to seed via admin API: a published category with at least 1 item
# (re-use the smoke test from Task 5/6; ensure isPublished=true was set)

curl -s "$BASE/api/mobile/client/portfolio/categories" -H "Authorization: Bearer $TOK" | jq
# Expected: { "success": true, "categories": [ { id, title, coverPhotoUrl: "http://...", itemsCount: N } ] }
# Empty published categories are absent from the list.
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add backend/routes/mobile-client.js
git commit -m "feat(portfolio): mobile API GET /portfolio/categories

Returns only published categories with items_count > 0, scoped to
client's salon. Cover URLs absolutized via shared helper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Mobile API — single category items

**Files:**
- Modify: `backend/routes/mobile-client.js`

- [ ] **Step 1: Add handler above module.exports**

```js
// GET /api/mobile/client/portfolio/categories/:id
router.get('/portfolio/categories/:id', mobileAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const cat = await db.oneOrNone(
      `SELECT id, title FROM portfolio_categories
       WHERE id=$1
         AND salon_id = (SELECT salon_id FROM clients WHERE id=$2)
         AND is_published = TRUE`,
      [id, req.client.clientId]
    );
    if (!cat) return res.status(404).json({ error: 'Категория не найдена' });

    const rows = await db.any(
      `SELECT i.id, i.title, i.description,
              i.photo_after_url, i.photo_before_url,
              s.id AS staff_id, s.name AS staff_name,
              s.custom_photo_url, s.avatar_url
       FROM portfolio_items i
       LEFT JOIN staff_members s ON s.id=i.staff_id
       WHERE i.salon_id = (SELECT salon_id FROM clients WHERE id=$1)
         AND i.category_id = $2
       ORDER BY i.display_order ASC, i.id ASC`,
      [req.client.clientId, id]
    );

    const items = rows.map(r => {
      let staffPhoto = null;
      if (r.staff_id) {
        const raw = (r.custom_photo_url && r.custom_photo_url.trim()) || r.avatar_url || null;
        staffPhoto = absolutizeUrl(baseUrl, raw);
      }
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        photoAfterUrl:  absolutizeUrl(baseUrl, r.photo_after_url),
        photoBeforeUrl: absolutizeUrl(baseUrl, r.photo_before_url),
        specialist: r.staff_id ? {
          id: r.staff_id, name: r.staff_name, photoUrl: staffPhoto,
        } : null,
      };
    });

    res.json({ success: true, category: { id: cat.id, title: cat.title }, items });
  } catch (e) {
    logger.error(`Get portfolio category error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Smoke test**

```bash
TOK="<mobile-client-jwt>" ; BASE="http://localhost:3001"

# Use the published category id from Task 7's seed
CID=<id-from-list>

curl -s "$BASE/api/mobile/client/portfolio/categories/$CID" -H "Authorization: Bearer $TOK" | jq
# Expected: { success, category: {id,title}, items: [{ id, title, ..., specialist: null|{...} }] }

# Negative: unpublished or other-salon category → 404
curl -s "$BASE/api/mobile/client/portfolio/categories/999999" -H "Authorization: Bearer $TOK"
# Expected: {"error":"Категория не найдена"}
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add backend/routes/mobile-client.js
git commit -m "feat(portfolio): mobile API GET /portfolio/categories/:id

Returns items in a published category with optional specialist info
(name + photo). 404 for unpublished or cross-salon categories.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Mobile API — items by staff

**Files:**
- Modify: `backend/routes/mobile-client.js`

- [ ] **Step 1: Add handler above module.exports**

```js
// GET /api/mobile/client/portfolio/by-staff/:staffId
router.get('/portfolio/by-staff/:staffId', mobileAuth, async (req, res) => {
  try {
    const staffId = parseInt(req.params.staffId, 10);
    if (!staffId) return res.status(400).json({ error: 'invalid staffId' });
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // verify staff belongs to client's salon
    const staff = await db.oneOrNone(
      `SELECT id FROM staff_members
       WHERE id=$1 AND salon_id = (SELECT salon_id FROM clients WHERE id=$2)`,
      [staffId, req.client.clientId]
    );
    if (!staff) return res.status(404).json({ error: 'Сотрудник не найден' });

    const rows = await db.any(
      `SELECT i.id, i.title, i.description,
              i.photo_after_url, i.photo_before_url,
              c.id AS category_id, c.title AS category_title
       FROM portfolio_items i
       JOIN portfolio_categories c
         ON c.id = i.category_id AND c.salon_id = i.salon_id
       WHERE i.staff_id = $1
         AND i.salon_id = (SELECT salon_id FROM clients WHERE id=$2)
         AND c.is_published = TRUE
       ORDER BY i.created_at DESC, i.id DESC`,
      [staffId, req.client.clientId]
    );

    const items = rows.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      photoAfterUrl:  absolutizeUrl(baseUrl, r.photo_after_url),
      photoBeforeUrl: absolutizeUrl(baseUrl, r.photo_before_url),
      category: { id: r.category_id, title: r.category_title },
    }));
    res.json({ success: true, items });
  } catch (e) {
    logger.error(`Get portfolio by-staff error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Smoke test**

```bash
TOK="<mobile-jwt>" ; BASE="http://localhost:3001"

# pick a staff_id that has at least one item attached (assign via admin PUT /items/:id with staffId)
SID=<staff-id>

curl -s "$BASE/api/mobile/client/portfolio/by-staff/$SID" -H "Authorization: Bearer $TOK" | jq
# Expected: { success, items: [{ id, title, ..., category: {id,title} }] } — possibly empty array

# Cross-salon staff → 404
curl -s "$BASE/api/mobile/client/portfolio/by-staff/999999" -H "Authorization: Bearer $TOK"
# Expected: {"error":"Сотрудник не найден"}
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add backend/routes/mobile-client.js
git commit -m "feat(portfolio): mobile API GET /portfolio/by-staff/:staffId

Returns items attributed to a specialist, only from published categories,
with category metadata embedded. 404 for cross-salon staff.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Frontend HTML scaffolding

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Add menu item under Mobile App group**

Open [frontend/index.html](frontend/index.html). Find line ~401:

```html
          <div class="stg-group-lbl">📱 Мобильное приложение</div>
          <div class="stg-item" data-sec="app-settings" onclick="navStg('app-settings',this)"><span class="stg-ic">⚙️</span>Настройки приложения</div>
```

Add a new `stg-item` immediately below the existing `app-settings` line:

```html
          <div class="stg-item" data-sec="portfolio" onclick="navStg('portfolio',this)"><span class="stg-ic">🖼️</span>Портфолио работ</div>
```

- [ ] **Step 2: Add settings section container**

Find the `stg-section` for `staff-profiles` (around line 702) — its end `</div>`. Immediately after the closing `</div>` of that section, add the new portfolio section:

```html
        <div class="stg-section" id="stg-portfolio">
          <div class="stg-h">Портфолио работ <button class="btn btn-pri" style="float:right;font-size:13px" onclick="openPortfolioCategoryCreate()">+ Новая категория</button></div>
          <div class="stg-sub" style="margin-bottom:16px">Категории и фото работ «до/после» для мобильного приложения. Изменения видны клиентам сразу после публикации категории.</div>

          <div id="portfolio-loading" style="color:#9ca3af;font-size:13px">Загрузка...</div>

          <!-- Level 1: categories -->
          <div id="portfolio-cats-view" style="display:none">
            <div id="portfolio-cats-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px"></div>
          </div>

          <!-- Level 2: items inside a category -->
          <div id="portfolio-items-view" style="display:none">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
              <button class="btn btn-sec" style="font-size:13px" onclick="loadPortfolioCategories()">← Все категории</button>
              <div style="font-weight:600" id="portfolio-cat-title">—</div>
              <div style="margin-left:auto;display:flex;gap:8px">
                <button class="btn btn-sec" style="font-size:13px" onclick="openPortfolioCategoryEdit()">Редактировать</button>
                <button class="btn" style="font-size:13px;color:#ef4444" onclick="deletePortfolioCategoryConfirm()">Удалить категорию</button>
                <button class="btn btn-pri" style="font-size:13px" onclick="openPortfolioItemCreate()">+ Добавить работу</button>
              </div>
            </div>
            <div id="portfolio-items-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px"></div>
          </div>
        </div>
```

- [ ] **Step 3: Add category modal**

Find an existing modal in the file (e.g. `staff-profile-modal`) and add the new modal below it (top-level under `<body>`, alongside other modals):

```html
<!-- Portfolio: category modal (create / edit) -->
<div id="portfolio-cat-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);align-items:center;justify-content:center;z-index:100">
  <div style="background:#fff;border-radius:14px;padding:24px;width:420px;max-width:90vw">
    <div style="font-weight:600;font-size:16px;margin-bottom:14px" id="portfolio-cat-modal-title">Новая категория</div>
    <div class="fg"><label class="fl">Название *</label><input type="text" id="portfolio-cat-title-input" maxlength="120" placeholder="Маникюр"></div>
    <div class="fg">
      <label class="fl">Обложка категории *</label>
      <div id="portfolio-cat-cover-preview" style="width:120px;height:120px;border-radius:10px;border:2px solid #e5e7eb;background:#f3f4f6;display:flex;align-items:center;justify-content:center;color:#9ca3af;margin-bottom:8px;overflow:hidden">Нет фото</div>
      <input type="file" id="portfolio-cat-cover-input" accept="image/*">
    </div>
    <div class="fg" id="portfolio-cat-publish-wrap" style="display:none">
      <label><input type="checkbox" id="portfolio-cat-published"> Опубликовать в мобильном приложении</label>
    </div>
    <div id="portfolio-cat-status" style="font-size:13px;margin-bottom:8px;min-height:18px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-sec" onclick="closePortfolioCategoryModal()">Отмена</button>
      <button class="btn btn-pri" onclick="savePortfolioCategory()">Сохранить</button>
    </div>
  </div>
</div>

<!-- Portfolio: item modal (create / edit) -->
<div id="portfolio-item-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);align-items:center;justify-content:center;z-index:100">
  <div style="background:#fff;border-radius:14px;padding:24px;width:520px;max-width:90vw;max-height:90vh;overflow-y:auto">
    <div style="font-weight:600;font-size:16px;margin-bottom:14px" id="portfolio-item-modal-title">Новая работа</div>
    <div class="fg"><label class="fl">Заголовок *</label><input type="text" id="portfolio-item-title-input" maxlength="80" placeholder="Окрашивание балаяж"></div>
    <div class="fg"><label class="fl">Описание</label><textarea id="portfolio-item-desc-input" maxlength="1000" rows="3"></textarea></div>
    <div class="fg"><label class="fl">Сотрудник</label><select id="portfolio-item-staff-select"><option value="">— Не указан —</option></select></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px">
      <div>
        <label class="fl">Фото "После" *</label>
        <div id="portfolio-item-after-preview" style="width:100%;aspect-ratio:1;border-radius:10px;border:2px solid #e5e7eb;background:#f3f4f6;background-size:cover;background-position:center"></div>
        <input type="file" id="portfolio-item-after-input" accept="image/*" style="margin-top:6px">
      </div>
      <div>
        <label class="fl">Фото "До"</label>
        <div id="portfolio-item-before-preview" style="width:100%;aspect-ratio:1;border-radius:10px;border:2px solid #e5e7eb;background:#f3f4f6;background-size:cover;background-position:center"></div>
        <input type="file" id="portfolio-item-before-input" accept="image/*" style="margin-top:6px">
        <button class="btn btn-sec" id="portfolio-item-before-clear" style="font-size:12px;margin-top:4px;display:none" onclick="clearPortfolioItemBefore()">Удалить «до»</button>
      </div>
    </div>
    <div id="portfolio-item-status" style="font-size:13px;margin-bottom:8px;min-height:18px"></div>
    <div style="display:flex;gap:8px;justify-content:space-between">
      <button class="btn" id="portfolio-item-delete-btn" style="color:#ef4444;display:none" onclick="deletePortfolioItemConfirm()">Удалить</button>
      <div style="display:flex;gap:8px;margin-left:auto">
        <button class="btn btn-sec" onclick="closePortfolioItemModal()">Отмена</button>
        <button class="btn btn-pri" onclick="savePortfolioItem()">Сохранить</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Add script tag**

Find the existing `<script src="js/pages/settings.js"></script>` (or similar). Add immediately after it:

```html
    <script src="js/pages/portfolio.js"></script>
```

- [ ] **Step 5: Reload browser, verify menu item appears (no JS yet)**

Open the staff frontend (`http://localhost:3001`) → Settings. Click `📱 Мобильное приложение` group → confirm "Портфолио работ" entry is visible. Clicking it should not error in the console (the section will just say "Загрузка..." since there's no JS yet).

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro
git add frontend/index.html
git commit -m "feat(portfolio): HTML scaffolding for portfolio admin section

Menu entry under Mobile App group, two-level section container with
empty grids, category modal and item modal markup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Frontend — Level 1 (categories grid)

**Files:**
- Create: `frontend/js/pages/portfolio.js`

- [ ] **Step 1: Create portfolio.js with state, loader, render, create-category modal**

Create [frontend/js/pages/portfolio.js](frontend/js/pages/portfolio.js):

```js
// ── Portfolio (До/После) admin page ───────────────────────────
'use strict';

let _portfolioCats = [];
let _portfolioCurrentCat = null;     // { id, title, ... } when at Level 2
let _portfolioCatModalMode = null;   // 'create' | 'edit'
let _portfolioCatWasDragging = false;

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ── Top-level loader ──────────────────────────────────────────
async function loadPortfolioCategories() {
  _portfolioCurrentCat = null;
  document.getElementById('portfolio-loading').style.display = 'block';
  document.getElementById('portfolio-cats-view').style.display = 'none';
  document.getElementById('portfolio-items-view').style.display = 'none';
  document.getElementById('portfolio-loading').textContent = 'Загрузка...';
  try {
    const data = await api('GET', '/api/portfolio/categories');
    _portfolioCats = data.categories || [];
    document.getElementById('portfolio-loading').style.display = 'none';
    document.getElementById('portfolio-cats-view').style.display = 'block';
    renderPortfolioCategories();
  } catch (e) {
    document.getElementById('portfolio-loading').textContent = 'Ошибка загрузки: ' + e.message;
  }
}

function renderPortfolioCategories() {
  const grid = document.getElementById('portfolio-cats-grid');
  if (!_portfolioCats.length) {
    grid.innerHTML = '<div style="color:#9ca3af;font-size:13px;grid-column:1/-1">Нет категорий. Нажмите «+ Новая категория».</div>';
    return;
  }
  grid.innerHTML = _portfolioCats.map(c => portfolioCatTile(c)).join('');
  initPortfolioCatDragDrop();
}

function portfolioCatTile(c) {
  const cover = c.coverPhotoUrl
    ? `<div style="width:100%;aspect-ratio:1;background:#f3f4f6 url('${_esc(c.coverPhotoUrl)}') center/cover;border-radius:10px"></div>`
    : `<div style="width:100%;aspect-ratio:1;background:#f3f4f6;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#d1d5db;font-size:32px">🖼️</div>`;
  const hiddenBadge = !c.isPublished ? '<div style="font-size:10px;color:#f59e0b;margin-top:4px">Скрыто</div>' : '';
  return `
    <div draggable="true" data-portfolio-cat-id="${c.id}" style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;cursor:pointer;transition:box-shadow .15s,opacity .15s;position:relative;background:#fff" onclick="openPortfolioCategory(${c.id})" onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.10)'" onmouseout="this.style.boxShadow=''">
      <div style="position:absolute;top:8px;left:8px;cursor:grab;color:#d1d5db;font-size:14px;line-height:1;user-select:none">⠿</div>
      ${cover}
      <div style="font-weight:600;font-size:13px;margin-top:8px">${_esc(c.title || '—')}</div>
      <div style="font-size:11px;color:#9ca3af">${c.itemsCount || 0} работ</div>
      ${hiddenBadge}
    </div>`;
}

// ── Drag-drop reorder for categories ──────────────────────────
function initPortfolioCatDragDrop() {
  const grid = document.getElementById('portfolio-cats-grid');
  if (!grid) return;
  let dragSrc = null;
  grid.querySelectorAll('[data-portfolio-cat-id]').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragSrc = card; _portfolioCatWasDragging = true;
      card.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      grid.querySelectorAll('[data-portfolio-cat-id]').forEach(c => c.style.outline = '');
      setTimeout(() => { _portfolioCatWasDragging = false; }, 50);
    });
    card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    card.addEventListener('dragenter', e => {
      e.preventDefault();
      if (card !== dragSrc) card.style.outline = '2px dashed #6366f1';
    });
    card.addEventListener('dragleave', () => { card.style.outline = ''; });
    card.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); card.style.outline = '';
      if (!dragSrc || dragSrc === card) return;
      const cards = [...grid.querySelectorAll('[data-portfolio-cat-id]')];
      const srcIdx = cards.indexOf(dragSrc);
      const dstIdx = cards.indexOf(card);
      if (srcIdx < dstIdx) grid.insertBefore(dragSrc, card.nextSibling);
      else grid.insertBefore(dragSrc, card);
      const order = [...grid.querySelectorAll('[data-portfolio-cat-id]')].map((el, i) => ({
        id: parseInt(el.dataset.portfolioCatId), display_order: i,
      }));
      try {
        await api('PUT', '/api/portfolio/categories/reorder', { order });
        notify('Порядок сохранён', 'ok');
      } catch (err) { notify('Ошибка: ' + err.message, 'err'); }
    });
  });
}

// ── Create / edit category modal ──────────────────────────────
function openPortfolioCategoryCreate() {
  _portfolioCatModalMode = 'create';
  document.getElementById('portfolio-cat-modal-title').textContent = 'Новая категория';
  document.getElementById('portfolio-cat-title-input').value = '';
  document.getElementById('portfolio-cat-cover-input').value = '';
  document.getElementById('portfolio-cat-cover-preview').innerHTML = 'Нет фото';
  document.getElementById('portfolio-cat-publish-wrap').style.display = 'none';
  document.getElementById('portfolio-cat-status').textContent = '';
  document.getElementById('portfolio-cat-modal').style.display = 'flex';
}

function openPortfolioCategoryEdit() {
  if (!_portfolioCurrentCat) return;
  _portfolioCatModalMode = 'edit';
  const c = _portfolioCurrentCat;
  document.getElementById('portfolio-cat-modal-title').textContent = 'Редактировать категорию';
  document.getElementById('portfolio-cat-title-input').value = c.title || '';
  document.getElementById('portfolio-cat-cover-input').value = '';
  const preview = document.getElementById('portfolio-cat-cover-preview');
  preview.innerHTML = c.coverPhotoUrl
    ? `<img src="${_esc(c.coverPhotoUrl)}" style="width:100%;height:100%;object-fit:cover">`
    : 'Нет фото';
  const pubWrap = document.getElementById('portfolio-cat-publish-wrap');
  pubWrap.style.display = 'block';
  document.getElementById('portfolio-cat-published').checked = !!c.isPublished;
  document.getElementById('portfolio-cat-status').textContent = '';
  document.getElementById('portfolio-cat-modal').style.display = 'flex';
}

function closePortfolioCategoryModal() {
  document.getElementById('portfolio-cat-modal').style.display = 'none';
}

async function savePortfolioCategory() {
  const status = document.getElementById('portfolio-cat-status');
  const title = document.getElementById('portfolio-cat-title-input').value.trim();
  if (!title) { status.style.color = '#ef4444'; status.textContent = 'Введите название'; return; }
  const file = document.getElementById('portfolio-cat-cover-input').files[0];

  try {
    let id;
    if (_portfolioCatModalMode === 'create') {
      if (!file) { status.style.color = '#ef4444'; status.textContent = 'Загрузите обложку'; return; }
      status.style.color = '#6b7280'; status.textContent = 'Создание...';
      const r = await api('POST', '/api/portfolio/categories', { title });
      id = r.id;
      await uploadPortfolioCover(id, file);
    } else {
      id = _portfolioCurrentCat.id;
      const isPublished = document.getElementById('portfolio-cat-published').checked;
      status.style.color = '#6b7280'; status.textContent = 'Сохранение...';
      await api('PUT', `/api/portfolio/categories/${id}`, { title, isPublished });
      if (file) await uploadPortfolioCover(id, file);
    }
    closePortfolioCategoryModal();
    notify('Сохранено', 'ok');
    await loadPortfolioCategories();
  } catch (e) {
    status.style.color = '#ef4444'; status.textContent = e.message;
  }
}

async function uploadPortfolioCover(categoryId, file) {
  const fd = new FormData();
  fd.append('photo', file);
  const tok = localStorage.getItem('lp_tk');
  const r = await fetch(`/api/portfolio/categories/${categoryId}/cover`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: fd,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Ошибка загрузки обложки');
  return d.url;
}

// ── Drill-in to Level 2 ───────────────────────────────────────
function openPortfolioCategory(catId) {
  if (_portfolioCatWasDragging) return;
  const c = _portfolioCats.find(x => x.id === catId);
  if (!c) return;
  _portfolioCurrentCat = c;
  document.getElementById('portfolio-cats-view').style.display = 'none';
  document.getElementById('portfolio-items-view').style.display = 'block';
  document.getElementById('portfolio-cat-title').textContent = c.title;
  loadPortfolioItems(); // implemented in Task 12
}

// stubs for Task 12 (so onclick refs don't 500)
function loadPortfolioItems() { document.getElementById('portfolio-items-grid').innerHTML = '<div style="color:#9ca3af">Загрузка работ — реализуется в следующей задаче</div>'; }
function openPortfolioItemCreate() {}
function openPortfolioItemEdit() {}
function closePortfolioItemModal() {}
function savePortfolioItem() {}
function clearPortfolioItemBefore() {}
function deletePortfolioItemConfirm() {}
async function deletePortfolioCategoryConfirm() {
  if (!_portfolioCurrentCat) return;
  if (!confirm(`Удалить категорию «${_portfolioCurrentCat.title}» и все работы?`)) return;
  try {
    await api('DELETE', `/api/portfolio/categories/${_portfolioCurrentCat.id}`);
    notify('Удалено', 'ok');
    await loadPortfolioCategories();
  } catch (e) { notify(e.message, 'err'); }
}

// expose to inline onclick handlers
window.loadPortfolioCategories = loadPortfolioCategories;
window.openPortfolioCategoryCreate = openPortfolioCategoryCreate;
window.openPortfolioCategoryEdit = openPortfolioCategoryEdit;
window.openPortfolioCategory = openPortfolioCategory;
window.closePortfolioCategoryModal = closePortfolioCategoryModal;
window.savePortfolioCategory = savePortfolioCategory;
window.deletePortfolioCategoryConfirm = deletePortfolioCategoryConfirm;
window.openPortfolioItemCreate = openPortfolioItemCreate;
window.openPortfolioItemEdit = openPortfolioItemEdit;
window.closePortfolioItemModal = closePortfolioItemModal;
window.savePortfolioItem = savePortfolioItem;
window.clearPortfolioItemBefore = clearPortfolioItemBefore;
window.deletePortfolioItemConfirm = deletePortfolioItemConfirm;
```

- [ ] **Step 2: Wire menu click to data loader**

Add this listener at the very bottom of `frontend/js/pages/portfolio.js`, AFTER all the `window.X = X` exposure lines:

```js
// Auto-load when the user navigates to the Портфолио menu entry. We use a
// click listener instead of patching navStg because navStg only toggles
// visibility — it doesn't have a per-section loader hook.
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-sec="portfolio"]');
  if (target) loadPortfolioCategories();
});
```

This avoids touching `settings.js` and works regardless of how `navStg` is implemented internally.

- [ ] **Step 3: Browser smoke test**

Use the MCP Playwright server (per `CLAUDE.md`):

1. Navigate to `http://localhost:3001`, log in as admin
2. Go to Settings → Мобильное приложение → Портфолио работ
3. Confirm grid is empty with the placeholder text
4. Click "+ Новая категория"
5. Enter title "Маникюр", pick any small image, click Сохранить
6. Confirm tile appears with cover photo and "0 работ"
7. Refresh the page; tile persists
8. Drag the tile (with another tile present) to a new position; confirm `notify('Порядок сохранён')`
9. Click tile → drills into Level 2 (showing the stub message — that's OK at this step)

If anything fails, fix and retry before committing.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro
git add frontend/js/pages/portfolio.js frontend/js/pages/settings.js
git commit -m "feat(portfolio): admin SPA — Level 1 categories grid

Categories list with cover/title/count, +Новая категория modal with
required cover upload, drag-drop reorder, drill-in to Level 2 stub.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Frontend — Level 2 (items grid + item modal)

**Files:**
- Modify: `frontend/js/pages/portfolio.js`

- [ ] **Step 1: Replace stubs with real implementations**

Open `frontend/js/pages/portfolio.js`. Delete exactly these seven stub function declarations (the comment line `// stubs for Task 12 ...` and the seven `function ... () {}` lines that follow it):

```js
// stubs for Task 12 (so onclick refs don't 500)
function loadPortfolioItems() { document.getElementById('portfolio-items-grid').innerHTML = '<div style="color:#9ca3af">Загрузка работ — реализуется в следующей задаче</div>'; }
function openPortfolioItemCreate() {}
function openPortfolioItemEdit() {}
function closePortfolioItemModal() {}
function savePortfolioItem() {}
function clearPortfolioItemBefore() {}
function deletePortfolioItemConfirm() {}
```

Leave `async function deletePortfolioCategoryConfirm()` and the `window.X = X` exposure block at the bottom of the file UNCHANGED.

In place of the deleted stubs, paste this code (it adds module-level state plus the real implementations):

```js
let _portfolioItems = [];
let _portfolioItemModalMode = null;     // 'create' | 'edit'
let _portfolioEditingItemId = null;
let _portfolioStaffOptions = [];
let _portfolioItemWasDragging = false;
let _portfolioPendingBeforeDeletion = false;

async function loadPortfolioItems() {
  if (!_portfolioCurrentCat) return;
  const grid = document.getElementById('portfolio-items-grid');
  grid.innerHTML = '<div style="color:#9ca3af;font-size:13px;grid-column:1/-1">Загрузка...</div>';
  try {
    const data = await api('GET', `/api/portfolio/categories/${_portfolioCurrentCat.id}/items`);
    _portfolioItems = data.items || [];
    renderPortfolioItems();
  } catch (e) {
    grid.innerHTML = `<div style="color:#ef4444">Ошибка: ${_esc(e.message)}</div>`;
  }
}

function renderPortfolioItems() {
  const grid = document.getElementById('portfolio-items-grid');
  if (!_portfolioItems.length) {
    grid.innerHTML = '<div style="color:#9ca3af;font-size:13px;grid-column:1/-1">Работ пока нет. Нажмите «+ Добавить работу».</div>';
    return;
  }
  grid.innerHTML = _portfolioItems.map(it => portfolioItemTile(it)).join('');
  initPortfolioItemDragDrop();
}

function portfolioItemTile(it) {
  const cover = it.photoAfterUrl
    ? `<div style="width:100%;aspect-ratio:3/4;background:#f3f4f6 url('${_esc(it.photoAfterUrl)}') center/cover;border-radius:10px"></div>`
    : `<div style="width:100%;aspect-ratio:3/4;background:#f3f4f6;border-radius:10px"></div>`;
  const staffBadge = it.staffName ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">👤 ${_esc(it.staffName)}</div>` : '';
  const beforeBadge = it.photoBeforeUrl ? '<span style="display:inline-block;padding:2px 6px;background:#eef2ff;color:#4f46e5;border-radius:4px;font-size:10px;margin-left:4px">До+После</span>' : '';
  return `
    <div draggable="true" data-portfolio-item-id="${it.id}" style="border:1px solid #e5e7eb;border-radius:12px;padding:10px;cursor:pointer;transition:box-shadow .15s,opacity .15s;position:relative;background:#fff" onclick="openPortfolioItemEdit(${it.id})" onmouseover="this.style.boxShadow='0 4px 16px rgba(0,0,0,.10)'" onmouseout="this.style.boxShadow=''">
      <div style="position:absolute;top:6px;left:6px;cursor:grab;color:#d1d5db;font-size:14px;user-select:none">⠿</div>
      ${cover}
      <div style="font-weight:600;font-size:13px;margin-top:8px">${_esc(it.title)}${beforeBadge}</div>
      ${staffBadge}
    </div>`;
}

function initPortfolioItemDragDrop() {
  const grid = document.getElementById('portfolio-items-grid');
  if (!grid) return;
  let dragSrc = null;
  grid.querySelectorAll('[data-portfolio-item-id]').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragSrc = card; _portfolioItemWasDragging = true;
      card.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      grid.querySelectorAll('[data-portfolio-item-id]').forEach(c => c.style.outline = '');
      setTimeout(() => { _portfolioItemWasDragging = false; }, 50);
    });
    card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    card.addEventListener('dragenter', e => {
      e.preventDefault();
      if (card !== dragSrc) card.style.outline = '2px dashed #6366f1';
    });
    card.addEventListener('dragleave', () => { card.style.outline = ''; });
    card.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); card.style.outline = '';
      if (!dragSrc || dragSrc === card) return;
      const cards = [...grid.querySelectorAll('[data-portfolio-item-id]')];
      const srcIdx = cards.indexOf(dragSrc);
      const dstIdx = cards.indexOf(card);
      if (srcIdx < dstIdx) grid.insertBefore(dragSrc, card.nextSibling);
      else grid.insertBefore(dragSrc, card);
      const order = [...grid.querySelectorAll('[data-portfolio-item-id]')].map((el, i) => ({
        id: parseInt(el.dataset.portfolioItemId), display_order: i,
      }));
      try {
        await api('PUT', '/api/portfolio/items/reorder', { order });
        notify('Порядок сохранён', 'ok');
      } catch (err) { notify('Ошибка: ' + err.message, 'err'); }
    });
  });
}

// ── Item modal ────────────────────────────────────────────────
async function ensurePortfolioStaffOptions() {
  if (_portfolioStaffOptions.length) return;
  try {
    const data = await api('GET', '/api/staff-profiles');
    _portfolioStaffOptions = (data.staff || []).filter(s => s.is_active);
  } catch (e) { _portfolioStaffOptions = []; }
}

function fillPortfolioStaffSelect(selectedId) {
  const sel = document.getElementById('portfolio-item-staff-select');
  sel.innerHTML = '<option value="">— Не указан —</option>' +
    _portfolioStaffOptions.map(s =>
      `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${_esc(s.name)}</option>`
    ).join('');
}

async function openPortfolioItemCreate() {
  _portfolioItemModalMode = 'create';
  _portfolioEditingItemId = null;
  _portfolioPendingBeforeDeletion = false;
  document.getElementById('portfolio-item-modal-title').textContent = 'Новая работа';
  document.getElementById('portfolio-item-title-input').value = '';
  document.getElementById('portfolio-item-desc-input').value = '';
  document.getElementById('portfolio-item-after-input').value = '';
  document.getElementById('portfolio-item-before-input').value = '';
  document.getElementById('portfolio-item-after-preview').style.backgroundImage = '';
  document.getElementById('portfolio-item-before-preview').style.backgroundImage = '';
  document.getElementById('portfolio-item-before-clear').style.display = 'none';
  document.getElementById('portfolio-item-delete-btn').style.display = 'none';
  document.getElementById('portfolio-item-status').textContent = '';
  await ensurePortfolioStaffOptions();
  fillPortfolioStaffSelect(null);
  document.getElementById('portfolio-item-modal').style.display = 'flex';
}

async function openPortfolioItemEdit(itemId) {
  if (_portfolioItemWasDragging) return;
  const it = _portfolioItems.find(x => x.id === itemId);
  if (!it) return;
  _portfolioItemModalMode = 'edit';
  _portfolioEditingItemId = itemId;
  _portfolioPendingBeforeDeletion = false;
  document.getElementById('portfolio-item-modal-title').textContent = 'Редактировать работу';
  document.getElementById('portfolio-item-title-input').value = it.title || '';
  document.getElementById('portfolio-item-desc-input').value = it.description || '';
  document.getElementById('portfolio-item-after-input').value = '';
  document.getElementById('portfolio-item-before-input').value = '';
  document.getElementById('portfolio-item-after-preview').style.backgroundImage =
    it.photoAfterUrl ? `url('${it.photoAfterUrl}')` : '';
  document.getElementById('portfolio-item-before-preview').style.backgroundImage =
    it.photoBeforeUrl ? `url('${it.photoBeforeUrl}')` : '';
  document.getElementById('portfolio-item-before-clear').style.display = it.photoBeforeUrl ? 'inline-block' : 'none';
  document.getElementById('portfolio-item-delete-btn').style.display = 'inline-block';
  document.getElementById('portfolio-item-status').textContent = '';
  await ensurePortfolioStaffOptions();
  fillPortfolioStaffSelect(it.staffId);
  document.getElementById('portfolio-item-modal').style.display = 'flex';
}

function closePortfolioItemModal() {
  document.getElementById('portfolio-item-modal').style.display = 'none';
  _portfolioEditingItemId = null;
}

function clearPortfolioItemBefore() {
  // mark for backend deletion at save time, and clear preview now
  _portfolioPendingBeforeDeletion = true;
  document.getElementById('portfolio-item-before-input').value = '';
  document.getElementById('portfolio-item-before-preview').style.backgroundImage = '';
  document.getElementById('portfolio-item-before-clear').style.display = 'none';
}

async function savePortfolioItem() {
  const status = document.getElementById('portfolio-item-status');
  const title = document.getElementById('portfolio-item-title-input').value.trim();
  if (!title) { status.style.color = '#ef4444'; status.textContent = 'Введите заголовок'; return; }
  const description = document.getElementById('portfolio-item-desc-input').value;
  const staffId = document.getElementById('portfolio-item-staff-select').value || null;
  const fAfter  = document.getElementById('portfolio-item-after-input').files[0];
  const fBefore = document.getElementById('portfolio-item-before-input').files[0];

  try {
    if (_portfolioItemModalMode === 'create') {
      if (!fAfter) { status.style.color = '#ef4444'; status.textContent = 'Загрузите фото «после»'; return; }
      status.style.color = '#6b7280'; status.textContent = 'Создание...';
      const fd = new FormData();
      fd.append('category_id', _portfolioCurrentCat.id);
      fd.append('title', title);
      fd.append('description', description);
      if (staffId) fd.append('staff_id', staffId);
      fd.append('after', fAfter);
      if (fBefore) fd.append('before', fBefore);
      const tok = localStorage.getItem('lp_tk');
      const r = await fetch('/api/portfolio/items', {
        method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Ошибка');
    } else {
      // edit: text fields + (optional) replace photos + (optional) delete before
      status.style.color = '#6b7280'; status.textContent = 'Сохранение...';
      await api('PUT', `/api/portfolio/items/${_portfolioEditingItemId}`, {
        title, description, staffId,
      });
      if (_portfolioPendingBeforeDeletion) {
        await api('DELETE', `/api/portfolio/items/${_portfolioEditingItemId}/before`);
      }
      if (fAfter || fBefore) {
        const fd = new FormData();
        if (fAfter)  fd.append('after',  fAfter);
        if (fBefore) fd.append('before', fBefore);
        const tok = localStorage.getItem('lp_tk');
        const r = await fetch(`/api/portfolio/items/${_portfolioEditingItemId}/photos`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${tok}` }, body: fd,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Ошибка загрузки фото');
      }
    }
    closePortfolioItemModal();
    notify('Сохранено', 'ok');
    await loadPortfolioItems();
  } catch (e) {
    status.style.color = '#ef4444'; status.textContent = e.message;
  }
}

async function deletePortfolioItemConfirm() {
  if (!_portfolioEditingItemId) return;
  if (!confirm('Удалить работу безвозвратно?')) return;
  try {
    await api('DELETE', `/api/portfolio/items/${_portfolioEditingItemId}`);
    closePortfolioItemModal();
    notify('Удалено', 'ok');
    await loadPortfolioItems();
  } catch (e) { notify(e.message, 'err'); }
}
```

(All `window.X = X` exposures from Task 11 already cover these — no changes needed there.)

- [ ] **Step 2: Browser smoke walkthrough**

Use Playwright MCP. From admin UI:

1. Open Settings → Портфолио работ
2. Open category from Task 11; confirm "Работ пока нет" message
3. Click "+ Добавить работу"
4. Enter title "Френч", pick "after" file, leave "before" empty, choose specialist from dropdown, save
5. Confirm tile appears with the photo, title, and "👤 <name>" badge, NO "До+После" badge
6. Click tile → modal opens with values pre-filled. Pick a "before" file. Save.
7. Confirm "До+После" badge appears
8. Click tile → click "Удалить «до»" → save. Confirm badge gone, before-photo cleared on tile
9. Drag-reorder two items. Confirm `notify('Порядок сохранён')` and persists across reload
10. Open category modal → check "Опубликовать" → save → confirm category list shows no "Скрыто" badge
11. Open mobile-API smoke: `curl /api/mobile/client/portfolio/categories` returns this category if it has items_count > 0

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add frontend/js/pages/portfolio.js
git commit -m "feat(portfolio): admin SPA — Level 2 items grid + item modal

Items list with photos/staff badge/before+after indicator, drag-drop
reorder within category, item modal handles create/edit including
photo replace and before-photo deletion.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: End-to-end verification

**Files:** none — this is a verification-only task.

- [ ] **Step 1: Full happy-path walkthrough (admin)**

In a fresh browser session:

1. Login as admin
2. Settings → Портфолио работ
3. Create category "Маникюр" with cover
4. Drill in, add work "Френч" with after-photo + before-photo + specialist
5. Add second work "Гель-лак" with only after-photo, no specialist
6. Reorder works
7. Edit category, set Опубликовать = true, save
8. Create second category "Окрашивание", add 1 item, leave UNPUBLISHED

Confirm via `mcp__postgres__query`:

```sql
SELECT title, is_published, cover_photo_url <> '' AS has_cover FROM portfolio_categories WHERE salon_id=<your-id>;
SELECT title, photo_before_url IS NOT NULL AS has_before, staff_id FROM portfolio_items WHERE salon_id=<your-id>;
```

- [ ] **Step 2: Full mobile-side verification**

Mint a mobile JWT for a client in the same salon. Run all three endpoints:

```bash
TOK="<mobile-jwt>" ; BASE="http://localhost:3001"

curl -s "$BASE/api/mobile/client/portfolio/categories" -H "Authorization: Bearer $TOK" | jq
# Expected: only "Маникюр" appears (Окрашивание is_published=false → hidden)
# itemsCount=2, coverPhotoUrl absolute

CID=<id-of-маникюр>
curl -s "$BASE/api/mobile/client/portfolio/categories/$CID" -H "Authorization: Bearer $TOK" | jq
# Expected: 2 items in correct order; "Френч" has photoBeforeUrl + specialist; "Гель-лак" has nulls

# By-staff (use the specialist id assigned to "Френч")
SID=<staff-id>
curl -s "$BASE/api/mobile/client/portfolio/by-staff/$SID" -H "Authorization: Bearer $TOK" | jq
# Expected: 1 item ("Френч") with category embedded

# Cross-salon attempt (mint mobile JWT for a different salon's client)
curl -s "$BASE/api/mobile/client/portfolio/categories/$CID" -H "Authorization: Bearer $OTHER_TOK"
# Expected: {"error":"Категория не найдена"}
```

- [ ] **Step 3: File cleanup verification**

```bash
# Note current portfolio file count
ls /root/loyalpro/frontend/uploads/ | grep '^portfolio_' | wc -l
# Suppose it returns N

# Replace the after-photo on "Гель-лак" via UI (upload a new image, save)
# Check count again
ls /root/loyalpro/frontend/uploads/ | grep '^portfolio_' | wc -l
# Expected: still N (old after-photo deleted, new one added → net zero)

# Delete category "Окрашивание" via UI
ls /root/loyalpro/frontend/uploads/ | grep '^portfolio_' | wc -l
# Expected: N decreased by (1 cover + 1 after-photo) for that category
```

If file counts don't match expectations, debug `safeUnlink` calls and re-test.

- [ ] **Step 4: Run unit tests one more time**

```bash
cd /root/loyalpro/backend && npx jest portfolio.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit nothing (no code changes), but tag completion**

```bash
cd /root/loyalpro
git log --oneline -13
# Should show 12 portfolio commits + the spec commit
```

---

## Notes for the executing engineer

- **Permission to add `/api/portfolio` to public routes**: NO. Admin-only via `requireRole('owner','admin')` middleware. Specialists do not need access (per spec).
- **Migrations safety**: existing project pattern is `.catch(() => {})` on every `client.query` — this swallows errors silently. We follow the existing convention because non-fatal "already exists" errors should not crash boot. If any migration error is suspected, run the schema verification query manually (Task 1 step 4) to confirm.
- **multer storage choice**: We use `memoryStorage()` instead of `diskStorage()` (which `routes/staff.js` uses) because we need to know the new entity's `id` BEFORE writing the file (for filename templating). For categories: insert row with empty cover, get id, then write file. For items: insert row with empty photo URLs, get id, write file, update URLs. This avoids ever having an orphan file with a wrong name.
- **Backwards compat**: nothing breaks — we only ADD tables/routes/UI. Mobile app must opt in to fetching portfolio (it's safe to deploy backend before mobile).
- **Out of scope reminder** (do not add): per-item visibility, image resizing, watermarking, hierarchical categories, work-date field, multi-photo galleries beyond before/after.
