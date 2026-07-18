# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LoyalPro — loyalty program platform for beauty salons integrated with YClients CRM. Three components share one repo:

- **`backend/`** — Node.js/Express API server (port 3001). Serves both the staff web frontend and the mobile client app.
- **`frontend/`** — Vanilla JS single-page app for salon staff. Served as static files by the backend.
- **`mobile/`** — Expo/React Native app for end clients (loyalty card, bonus balance).

## Commands

### Backend
```bash
# Development (auto-reload)
cd backend && npm run dev

# Production via PM2
pm2 start ecosystem.config.js

# Restart production
pm2 restart loyalpro

# View logs
pm2 logs loyalpro
# or
tail -f backend/logs/*.log
```

### Mobile
```bash
cd mobile && npm install
npx expo start
```

### Tests (backend)
```bash
cd backend
node clients-api.test.js
node homecare-tree.test.js
node test-auth-integration.js   # integration, requires running server
```

## Architecture

### Backend structure
- `server.js` — entry point: sets up Express, mounts routes, starts cron jobs
- `config.js` — all env vars and constants in one place
- `db.js` — two PostgreSQL pools: `pool`/`db` (main app DB) and `botPool`/`botDb` (Telegram bot DB on Beget)
- `migrations.js` — runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS` style safe migrations on startup
- `routes/index.js` — mounts all routers; handles JWT auth inline for `/api/*` routes
- `routes/webhook.js` — YClients webhook at `/yclients/webhook.v2/:companyId` (no JWT, responds 200 immediately then processes async)
- `services/loyalty.js` — cashback calculation, sync from YClients, bonus accrual logic
- `services/yclients.js` — all YClients REST API calls; has in-memory cache for product/service trees
- `services/home-care.js` — "домашний уход" (home care) goods catalog sync
- `services/segments.js` — client segmentation refresh
- `services/staff.js` — staff data sync
- `services/portfolio.js` — pure helpers (filename templating, reorder validation, URL absolutize) shared by admin route + mobile API. No DB/HTTP — unit-tested in `portfolio.test.js`

### Auth & roles
JWT in `Authorization: Bearer <token>` header (or `?token=` for downloads). Roles: `owner > admin > specialist`. Specialists can only access `/api/home-care`, `/api/auth`, `/api/template-settings`. Public routes (no JWT): `/api/auth/login`, `/api/auth/register`, `/api/app-settings`.

Mobile clients use a separate auth path: `routes/mobile-auth.js` + `routes/mobile-client.js` under `/api/mobile/`.

### CORS
Managed in `server.js`. The whitelist is set via `ALLOWED_ORIGINS` env var (comma-separated) or falls back to hardcoded defaults. To add an origin, set `ALLOWED_ORIGINS` in the environment — do not edit the hardcoded list unless adding a permanent default.

### Cron jobs (all TZ: Europe/Moscow)
- `0 10 * * *` — birthday bonuses
- `0 */3 * * *` — YClients sync + goods categories sync
- `0 * * * *` — staff data sync

### Database
PostgreSQL (Beget cloud, SSL). Uses `pg` pool directly — no ORM. Helper `db` object wraps pool with `.query`, `.one`, `.many`, `.any`, `.oneOrNone`. All schema changes go through `migrations.js` using `IF NOT EXISTS` / `DO NOTHING` patterns — never destructive.

### Frontend (staff SPA)
`frontend/js/app.js` — entry, router, init  
`frontend/js/core/` — api.js, auth.js, nav.js, theme.js, utils.js  
`frontend/js/pages/` — one file per page (dashboard, clients, records, staff, segments, settings, home-care, users, portfolio)

API calls go through `core/api.js` which attaches JWT from localStorage automatically.

### Multi-salon
All DB tables have `salon_id` FK to `salons`. Every API route resolves the salon from `req.user.salon_id`. Never run queries without scoping to `salon_id`.

## Tools

### Database queries
Always use the **MCP PostgreSQL server** (`mcp__postgres__query`) for direct DB queries — do not run `psql` via bash.

### Browser / UI testing
Always use the **MCP Playwright server** (`mcp__playwright__*`) for browser automation and UI testing — do not spawn Playwright via bash scripts.

### Portfolio module (До/После)
"Before/after" gallery for the mobile client app, managed by salon admins under Settings → Mobile App → Портфолио работ.

**Tables (`migrations.js`):**
- `portfolio_categories` — `id, salon_id, title, cover_photo_url, display_order, is_published, created_at, updated_at`. `cover_photo_url DEFAULT ''` is a sentinel — categories created without a cover are publishable only after upload.
- `portfolio_items` — `id, salon_id, category_id, staff_id (nullable, ON DELETE SET NULL), title, description, photo_after_url (NOT NULL), photo_before_url (nullable), display_order, created_at, updated_at`.
- Indexes: `(salon_id, display_order)` on categories, `(salon_id, category_id, display_order)` on items, partial `(salon_id, staff_id) WHERE staff_id IS NOT NULL` on items.

**Admin API (`routes/portfolio.js`, mounted at `/api/portfolio`, `requireRole('owner','admin')`):**
- `GET/POST/PUT/DELETE /categories[/:id]` — list with `items_count`, create (empty cover sentinel), update title/`isPublished` (refuses publish without cover), cascade-delete with file cleanup.
- `POST /categories/:id/cover` — multipart cover upload, replaces old file on success.
- `PUT /categories/reorder` — batch `display_order` (declared **before** `:id` to avoid path-matcher collision).
- `GET /categories/:id/items`, `POST /items` (multipart `after` required + `before` optional), `PUT /items/:id` (text only), `POST /items/:id/photos` (replace either or both), `DELETE /items/:id/before` (clear before-photo), `DELETE /items/:id` (cascade files).
- `PUT /items/reorder` — same-category guard (Set over `category_id`); also declared **before** `/items/:id`.

**Mobile API (`routes/mobile-client.js`, `mobileAuth`):**
- `GET /api/mobile/client/portfolio/categories` — published categories with items_count > 0, scoped to client's salon. URLs absolutized.
- `GET /api/mobile/client/portfolio/categories/:id` — items in a published category, embeds `specialist:{id,name,photoUrl}|null`. Photo precedence: `custom_photo_url` (trimmed) > `avatar_url` > null.
- `GET /api/mobile/client/portfolio/by-staff/:staffId` — items attributed to a staff member, only from published categories, ordered `created_at DESC`.

**Multer config:** `memoryStorage()` (so the row id can be embedded in the filename), 5 MB cap, image-only filter. Files written to `frontend/uploads/portfolio_{cat,item}_<id>[_(after|before)]_<ts>.<ext>`. `safeUnlink` swallows ENOENT and only acts on `/uploads/...` paths.

**Frontend:** `frontend/js/pages/portfolio.js` — two-level admin SPA (categories grid → items grid in a category) with HTML5 drag-drop reorder on both levels and create/edit modals. Stub `staff-profile-modal` shape reused via shared classes (`stg-section`, `btn-pri`, `fg`/`fl`).

### AI-агент: управление и гейт допуска
- `services/agent-gate.js` — чистые хелперы: `normalizePhoneKey` (РФ `8→7`), `decideGate` (порядок: enabled → чёрный список → режим/белый). Юнит-тесты `agent-gate.test.js`.
- `services/agent-settings.js` — настройки (`agent_settings`) и списки номеров (`agent_number_rules`); `isAllowed(salonId, phone)` объединяет их через `decideGate` (fail-closed без `salonId`). Номера хранятся каноничными (нормализуются при записи в `addNumberRule`).
- `routes/agent-settings.js` (`/api/agent`, owner/admin) — тумблер, режим `all|whitelist`, CRUD номеров.
- `routes/chatpush-webhook.js` зовёт `isAllowed` перед авто-ответом. Два уровня: env `CHATPUSH_AGENT_ENABLED` (глобальный kill-switch) И per-salon настройки из админки.
- Фронт: модалка «⚙️ Агент» на странице «Чат» (`frontend/js/pages/agent-settings.js`).

## Key constraints

- **Webhook handler must respond 200 immediately** before any async processing — YClients retries on timeout.
- **Advisory locks** are used in `processRecordEvent` to prevent race conditions on duplicate webhook deliveries — do not remove them.
- **Cashback accrual rule** — бонусы начисляются **только** если визит оплачен полностью деньгами: без применения бонусов и без скидок. Если клиент использовал бонусы или скидку — кэшбэк не начисляется (`finances_operation` type check в loyalty service).
- **`db.one` vs `db.oneOrNone`** — both exist; `one` throws if not found, `oneOrNone` returns null. Use `oneOrNone` for lookups that may miss.
- **Timezone** — server runs TZ=Europe/Moscow. All date arithmetic must be Moscow-local. Use `AT TIME ZONE 'Europe/Moscow'` in SQL when comparing dates.
