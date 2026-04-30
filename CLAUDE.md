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
`frontend/js/pages/` — one file per page (dashboard, clients, records, staff, segments, settings, home-care, users)

API calls go through `core/api.js` which attaches JWT from localStorage automatically.

### Multi-salon
All DB tables have `salon_id` FK to `salons`. Every API route resolves the salon from `req.user.salon_id`. Never run queries without scoping to `salon_id`.

## Tools

### Database queries
Always use the **MCP PostgreSQL server** (`mcp__postgres__query`) for direct DB queries — do not run `psql` via bash.

### Browser / UI testing
Always use the **MCP Playwright server** (`mcp__playwright__*`) for browser automation and UI testing — do not spawn Playwright via bash scripts.

## Key constraints

- **Webhook handler must respond 200 immediately** before any async processing — YClients retries on timeout.
- **Advisory locks** are used in `processRecordEvent` to prevent race conditions on duplicate webhook deliveries — do not remove them.
- **Cashback accrual rule** — бонусы начисляются **только** если визит оплачен полностью деньгами: без применения бонусов и без скидок. Если клиент использовал бонусы или скидку — кэшбэк не начисляется (`finances_operation` type check в loyalty service).
- **`db.one` vs `db.oneOrNone`** — both exist; `one` throws if not found, `oneOrNone` returns null. Use `oneOrNone` for lookups that may miss.
- **Timezone** — server runs TZ=Europe/Moscow. All date arithmetic must be Moscow-local. Use `AT TIME ZONE 'Europe/Moscow'` in SQL when comparing dates.
