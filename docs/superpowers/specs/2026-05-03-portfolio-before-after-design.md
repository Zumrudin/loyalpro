# Portfolio (До/После) — Design Spec

**Date:** 2026-05-03
**Status:** Approved for implementation planning
**Scope:** New module — gallery of "before/after" work results, exposed to mobile app

## 1. Goal

Add a section in admin UI under **Settings → 📱 Мобильное приложение → Портфолио работ** that lets salon owners/admins create categories of work results (e.g. "Маникюр", "Окрашивание") and upload photos with descriptions. Each photo can optionally be paired with a "before" shot and attributed to a specific specialist. The mobile client app fetches this data and displays it as a gallery.

## 2. Decisions Locked In

| Question | Decision |
|----------|----------|
| Item shape | Hybrid: required "after" photo, optional "before" photo (variant C in brainstorm) |
| Specialist link | Optional FK to `staff_members` (variant B) |
| Visibility | `is_published` flag on **category only** (variant B) |
| Item fields | Title (≤80) + description (≤1000) + optional staff (variant B + staff dropdown) |
| Categories | Flat (no hierarchy) — YAGNI |
| Reorder | Drag-drop for both categories and items, mirroring staff cards pattern |
| Cover photo | Required on category — cannot publish without one |
| Photo upload mechanics | Reused from `routes/staff.js` (multer disk, 5MB, image mime) |

## 3. Data Model

Two new tables, both scoped by `salon_id` (project convention — every table has `salon_id` FK to `salons`).

### `portfolio_categories`

```sql
CREATE TABLE IF NOT EXISTS portfolio_categories (
  id              SERIAL PRIMARY KEY,
  salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  title           VARCHAR(120) NOT NULL,
  cover_photo_url TEXT NOT NULL,
  display_order   INTEGER NOT NULL DEFAULT 0,
  is_published    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_categories_salon_order
  ON portfolio_categories (salon_id, display_order);
```

Note: `cover_photo_url` is `NOT NULL` at the DB level. Bootstrap order in admin UI is: create category row with a temporary placeholder URL value via `POST /categories` → immediately upload cover via `POST /categories/:id/cover`. The category is treated as "draft" (not selectable for publishing) until cover upload succeeds. Backend enforces this in the publish flow: `PUT /categories/:id` rejects `is_published=true` if `cover_photo_url` equals the placeholder sentinel.

Alternative considered: making `cover_photo_url` nullable. Rejected — every category row exposed to mobile must have a cover, so we'd just be moving the validation from DB to runtime. Sentinel placeholder keeps the invariant in schema.

Sentinel value: `''` (empty string). Backend validates `cover_photo_url <> ''` before allowing `is_published=true`.

### `portfolio_items`

```sql
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
);

CREATE INDEX IF NOT EXISTS idx_portfolio_items_category_order
  ON portfolio_items (salon_id, category_id, display_order);

CREATE INDEX IF NOT EXISTS idx_portfolio_items_staff
  ON portfolio_items (salon_id, staff_id) WHERE staff_id IS NOT NULL;
```

`salon_id` is denormalized on `portfolio_items` (could be derived from `category_id`) — matches existing project convention (e.g. `goods_sale_items.salon_id` is denormalized from `goods_sales.salon_id`). Enables fast scope checks without an extra JOIN.

### Migrations

Added to `backend/migrations.js` using the project's existing pattern: `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. Idempotent — safe to re-run on every server boot.

## 4. Admin API

Mounted as `/api/portfolio` in `backend/routes/index.js` after `/api/app-settings`. Implementation lives in new file `backend/routes/portfolio.js`.

All endpoints use `auth + requireRole('owner', 'admin')` middleware (specialists do not manage portfolio). Every query filters by `req.user.salonId`.

### Categories

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/portfolio/categories` | — | `{ categories: [{ id, title, coverPhotoUrl, displayOrder, isPublished, itemsCount }] }` |
| `POST` | `/api/portfolio/categories` | `{ title }` | `{ id }` (cover_photo_url='' until upload) |
| `PUT` | `/api/portfolio/categories/:id` | `{ title?, isPublished? }` | `{ ok: true }` — 400 if trying to publish without cover |
| `POST` | `/api/portfolio/categories/:id/cover` | multipart `photo` | `{ ok, url }` |
| `DELETE` | `/api/portfolio/categories/:id` | — | `{ ok }` — cascades items, removes files from disk |
| `PUT` | `/api/portfolio/categories/reorder` | `{ order: [{ id, display_order }] }` | `{ ok }` |

### Items

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/portfolio/categories/:id/items` | — | `{ items: [{ id, title, description, staffId, staffName, photoAfterUrl, photoBeforeUrl, displayOrder }] }` |
| `POST` | `/api/portfolio/items` | multipart: fields `category_id, title, description, staff_id`; files `after` (req), `before` (opt) | `{ id, photoAfterUrl, photoBeforeUrl }` |
| `PUT` | `/api/portfolio/items/:id` | `{ title, description, staffId, categoryId }` | `{ ok }` |
| `POST` | `/api/portfolio/items/:id/photos` | multipart `after?, before?` | `{ photoAfterUrl, photoBeforeUrl }` — replace files atomically |
| `DELETE` | `/api/portfolio/items/:id/before` | — | `{ ok }` — removes only the "before" photo |
| `DELETE` | `/api/portfolio/items/:id` | — | `{ ok }` — removes both files from disk |
| `PUT` | `/api/portfolio/items/reorder` | `{ order: [{ id, display_order }] }` | `{ ok }` — items must all belong to the same category |

### File Upload Conventions

Reused from `backend/routes/staff.js`:

- multer disk storage → `frontend/uploads/`
- `limits.fileSize = 5 * 1024 * 1024`
- `fileFilter`: `/^image\//.test(file.mimetype)`
- URL stored as `/uploads/<filename>`

Filename templates:

- `portfolio_cat_<categoryId>_<timestamp>.<ext>`
- `portfolio_item_<itemId>_after_<timestamp>.<ext>`
- `portfolio_item_<itemId>_before_<timestamp>.<ext>`

### File Cleanup (improvement over staff.js pattern)

The existing `staff.js` does not delete old photos when a new one replaces them, so `frontend/uploads/` slowly bloats. The new module fixes this:

- On cover replace: `fs.unlink` previous `cover_photo_url` (if not the sentinel)
- On photo replace: `fs.unlink` previous `photo_after_url` / `photo_before_url`
- On item delete: `fs.unlink` both photo files
- On category delete: `fs.unlink` cover + every item's photos (loop over cascaded items before `DELETE`)
- `ENOENT` swallowed — file may already be gone, this is non-fatal

## 5. Mobile API

New endpoints added to `backend/routes/mobile-client.js`. All use `mobileAuth` middleware. Salon scope resolved through `clients.salon_id` — same pattern as existing `/specialists` endpoint.

### `GET /api/mobile/client/portfolio/categories`

```json
{
  "success": true,
  "categories": [
    {
      "id": 12,
      "title": "Маникюр",
      "coverPhotoUrl": "https://api.example.com/uploads/portfolio_cat_12_1714000000.jpg",
      "itemsCount": 8
    }
  ]
}
```

Filter: `is_published = TRUE` AND `itemsCount > 0` (empty published categories are hidden — there's nothing for the client to look at). Sorted by `display_order ASC, id ASC`.

### `GET /api/mobile/client/portfolio/categories/:id`

```json
{
  "success": true,
  "category": { "id": 12, "title": "Маникюр" },
  "items": [
    {
      "id": 45,
      "title": "Френч с дизайном",
      "description": "Покрытие гель-лак, длина натуральная.",
      "photoAfterUrl": "https://api.example.com/uploads/portfolio_item_45_after_...jpg",
      "photoBeforeUrl": null,
      "specialist": {
        "id": 23,
        "name": "Анна П.",
        "photoUrl": "https://api.example.com/uploads/staff_23_...jpg"
      }
    }
  ]
}
```

Validates: category belongs to client's salon AND `is_published=TRUE`, else `404`. `specialist` is `null` when `staff_id IS NULL`. Items sorted by `display_order ASC, id ASC`.

### `GET /api/mobile/client/portfolio/by-staff/:staffId`

Used on the specialist profile screen to render a "Работы мастера" block.

```json
{
  "success": true,
  "items": [
    {
      "id": 45,
      "title": "Френч с дизайном",
      "description": "...",
      "photoAfterUrl": "...",
      "photoBeforeUrl": null,
      "category": { "id": 12, "title": "Маникюр" }
    }
  ]
}
```

Filter: only items whose category is `is_published=TRUE`. Validates that `staffId` belongs to the client's salon. Returns empty `items: []` if there are no works.

### URL Normalization

Same pattern as `/specialists`:

```js
const baseUrl = `${req.protocol}://${req.get('host')}`;
const abs = (url) => (url && url.startsWith('http')) ? url : (url ? `${baseUrl}${url}` : null);
```

Applied to `coverPhotoUrl`, `photoAfterUrl`, `photoBeforeUrl`, `specialist.photoUrl`.

### Response Style

camelCase keys, `success: true` envelope — matches existing mobile API conventions.

### Performance

- Category list: single SQL with `LEFT JOIN LATERAL (SELECT COUNT(*) FROM portfolio_items WHERE category_id = c.id) ic ON TRUE` — one round-trip.
- Single category items: single SQL with `LEFT JOIN staff_members` — no N+1.
- By-staff: single SQL with `JOIN portfolio_categories` to enforce `is_published`.

## 6. Admin UI

### Placement

New entry in the existing settings menu under group `📱 Мобильное приложение` in `frontend/index.html`:

```
📱 Мобильное приложение
   ├─ Контакты и логотип       (existing — app-settings)
   ├─ Сотрудники в приложении  (existing — staff-profiles)
   └─ Портфолио работ          ← NEW
```

(Note: "Карточки сотрудников" sits under group `👥 Сотрудники` in the current layout — left as-is, since it pulls double duty for analytics.)

### Two-level navigation

**Level 1 — Categories grid** (default view):

- Auto-fill grid `repeat(auto-fill, minmax(220px, 1fr))` (matches staff cards grid)
- Tile contents:
  - Square cover (object-fit: cover)
  - Title
  - Counter `N работ`
  - Badge "Скрыто" if `is_published=false`
  - Drag-handle `⠿` top-left for reorder
- Click → drill into Level 2
- Top-bar button `+ Новая категория` → modal:
  - Input "Название категории"
  - File picker "Обложка категории *" (required)
  - On submit: `POST /categories` with title → receive id → `POST /categories/:id/cover` with file → reload list

**Level 2 — Category contents**:

- Breadcrumb `← Все категории / Маникюр`
- Top-bar buttons: `Редактировать категорию`, `Удалить категорию` (with confirm), `+ Добавить работу`
- Grid of item tiles using `photo_after_url` as preview (3:4 aspect ratio)
- Tile shows:
  - Photo preview
  - Title
  - Specialist badge "👤 Анна П." if `staff_id` is set
  - Badge "До+После" if `photo_before_url` is present
  - Drag-handle for reorder within category
- Click tile → edit modal

### Item modal (create / edit)

Fields:

- `Заголовок` — input, required, ≤80 chars
- `Описание` — textarea, optional, ≤1000 chars
- `Сотрудник` — select populated from `GET /api/staff-profiles?include_fired=0`, default `«— Не указан —»`
- `Фото "После" *` — file slot, required, with 200×200 cover preview
- `Фото "До"` — file slot, optional, with preview + button "Удалить" (calls `DELETE /items/:id/before`)

Buttons: `Сохранить`, `Удалить работу` (with confirm), `Отмена`.

### Drag-drop reorder

Reuses the pattern from `frontend/js/pages/settings.js` (`initStaffDragDrop` → `saveStaffOrder`). Calls:

- `PUT /api/portfolio/categories/reorder` for Level 1
- `PUT /api/portfolio/items/reorder` for Level 2

### Implementation file

New file `frontend/js/pages/portfolio.js`. Continues the project's gradual JS-by-page split (per `MEMORY.md`: refactoring strategy is to break by page incrementally, one session at a time).

Public functions exposed on `window`: `loadPortfolioCategories`, `openCategoryModal`, `openItemModal`, `savePortfolioCategory`, `savePortfolioItem`, etc. Wired via inline `onclick` attributes — matches existing nav style.

Wired in `frontend/index.html`:
- New `<script src="js/pages/portfolio.js"></script>` after `settings.js`
- New menu item `<div class="stg-item" data-sec="portfolio" onclick="navStg('portfolio',this)">`
- New section `<div class="stg-section" id="stg-portfolio">` with the Level-1 container

### Notifications & errors

Use the existing `notify(msg, 'ok'|'err')` helper (already used throughout `settings.js`).

## 7. Error Handling Edge Cases

| Case | Behavior |
|------|----------|
| Upload non-image file | multer fileFilter rejects, returns `400 { error: 'Только изображения' }` |
| File > 5MB | multer returns `LIMIT_FILE_SIZE`, mapped to `400` |
| Reorder list contains items from another category | Validate all `id`s belong to the requested `category_id` (server-side); reject `400` |
| Mobile fetches category from another salon | `404` (don't leak existence) |
| Specialist deleted while attached to item | `staff_id` becomes `NULL` via `ON DELETE SET NULL`; mobile API returns `specialist: null` |
| Category cover upload fails after row insert | Category remains in "draft" state (`cover_photo_url=''`, `is_published` blocked); admin can retry |

## 8. Testing Plan

- Backend tests in `backend/tests/portfolio.test.js`:
  - CRUD on categories and items, salon-scoping (cross-salon access returns 404)
  - File upload + cleanup on replace/delete (assert `frontend/uploads/` files removed)
  - Reorder validation (mixed-category items rejected)
  - Publish blocked when cover is empty
- Manual mobile API smoke test (via curl with mobile JWT) for the three GET endpoints
- Manual UI walkthrough: create category → upload cover → add item with both photos → reorder → publish → verify mobile sees it

## 9. Out of Scope

- Hierarchical (nested) categories
- Per-item visibility flag (only category-level)
- Image processing/resizing — uploaded as-is, frontend handles `object-fit: cover`
- Image watermarking
- Item creation/editing by specialists (only admin/owner)
- "Date of work" field — can be added later via migration if needed; for now `created_at` is the sort key
- Multi-photo items (galleries beyond before/after pair)
