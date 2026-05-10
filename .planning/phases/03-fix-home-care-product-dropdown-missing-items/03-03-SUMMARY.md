---
phase: 03-fix-home-care-product-dropdown-missing-items
plan: 03
subsystem: backend/routes/home-care + tests
tags: [endpoints, repoint, blacklist, multi-salon, jest, wave-3]
requires:
  - yclients_goods_catalog table (Wave 1)
  - HOME_CARE_CATEGORY_BLACKLIST + isBlacklisted (Wave 1)
  - syncGoodsCatalog body (Wave 2)
  - getTreeCache/setTreeCache from backend/services/yclients.js
  - db helper from backend/db.js
provides:
  - GET /api/home-care/products reads yclients_goods_catalog with NOT is_archived + isBlacklisted JS-filter
  - GET /api/home-care/product-tree reads yclients_goods_catalog grouped by COALESCE(NULLIF(trim(category_title),''),'Без категории') with isBlacklisted JS-filter
  - backend/yclients-goods-catalog.test.js — 29-test Jest suite covering pure helpers + sync smoke (offline)
affects:
  - backend/routes/home-care.js (legacy goods_sale_items JOIN goods_sales source removed from /products and /product-tree; /services, /service-tree, /sync-goods-categories, prescriptions CRUD untouched)
tech-stack:
  added: []
  patterns:
    - Pull 3× cap from SQL, JS-filter blacklist, slice to cap (autocomplete)
    - Group by COALESCE(NULLIF(trim(category_title),''),'Без категории') (tree)
    - jest.mock at test-file-relative paths to satisfy resolved-module hoisting
    - test.each parametrized blacklist cases (16 input/output pairs)
key-files:
  created:
    - backend/yclients-goods-catalog.test.js
  modified:
    - backend/routes/home-care.js
decisions:
  - D-01: /products and /product-tree now read yclients_goods_catalog as source of truth (sales-history derived dropdown retired for these two endpoints)
  - D-02: Tree grouping by category_title (COALESCE fallback to 'Без категории')
  - D-03: 6-entry blacklist enforced JS-side after SQL fetch (hides Расходники, Канцелярия, Препараты, Аптека, Сертификаты Сеть Peri Clinic, Абонементы Сеть Peri Clinic)
  - D-04: 'Без категории' passes through (fallback for empty/null is_not blacklisted)
  - D-05: NOT is_archived filter at SQL layer in both handlers
  - D-18: getTreeCache/setTreeCache contract preserved in /product-tree (read+write under empty search, bypass on filtered search; clearTreeCache invalidation owned by syncGoodsCatalog from Wave 2)
  - D-19: Empty catalog returns [] (no blocking sync on request)
metrics:
  duration: "3m 48s"
  completed: 2026-05-10
  tasks: 3
  commits: 3
  files_created: 1
  files_modified: 1
  net_lines_added: 285
requirements:
  - GOAL-01
  - GOAL-02
  - GOAL-05
  - GOAL-07
---

# Phase 03 Plan 03: Wave 3 — Endpoint Repointing + Unit Tests Summary

Wave 3 swaps the data source for `/api/home-care/products` and `/api/home-care/product-tree` from the legacy sales-history view (`goods_sale_items JOIN goods_sales`) to the new `yclients_goods_catalog` table populated by `syncGoodsCatalog` from Wave 2. Both endpoints now apply the 6-entry category blacklist (D-03) JS-side and filter archived rows at the SQL layer. Response shapes are preserved verbatim — frontend stays untouched. A new Jest suite at `backend/yclients-goods-catalog.test.js` covers all three pure helpers plus a smoke test against `syncGoodsCatalog` with stubbed `ycGet`/`db`/`logger`, totalling 29 passing tests with no real network or DB access.

## Tasks Completed

| Task | Name                                                                  | Commit    | Files                                  |
| ---- | --------------------------------------------------------------------- | --------- | -------------------------------------- |
| 1    | Repoint GET /api/home-care/products onto yclients_goods_catalog       | `af6c81e` | backend/routes/home-care.js            |
| 2    | Repoint GET /api/home-care/product-tree onto yclients_goods_catalog   | `e63ab87` | backend/routes/home-care.js            |
| 3    | Jest unit tests for pure helpers + syncGoodsCatalog smoke (29 passes) | `e4064af` | backend/yclients-goods-catalog.test.js |

## Diff Summary

### `backend/routes/home-care.js`

- **Line 12 (new):** `const { isBlacklisted } = require('../services/yclients-goods-catalog');` — single import, no duplicates of existing imports.
- **`/products` handler (lines 101-123):** legacy `SELECT DISTINCT ON (lower(trim(title))) … FROM goods_sale_items gsi JOIN goods_sales gs …` replaced with `SELECT title, yclients_good_id AS id, category_title FROM yclients_goods_catalog WHERE salon_id=$1 AND NOT is_archived AND title IS NOT NULL AND trim(title)!='' AND ($2='' OR title ILIKE '%' || $2 || '%') ORDER BY lower(trim(title)), title LIMIT $3`. Pulls 3× cap to compensate for blacklist-trim, then `rows.filter(r => !isBlacklisted(r.category_title)).slice(0, cap).map(({title,id}) => ({title,id}))`. Response shape unchanged: `[{title, id}]`. UNIQUE `(salon_id, yclients_good_id)` (Wave 1 schema) + `NOT is_archived` already gives one row per real product, so old `DISTINCT ON` removed.
- **`/product-tree` handler (lines 187-219):** legacy SQL replaced with `SELECT title, COALESCE(NULLIF(trim(category_title),''),'Без категории') AS cat FROM yclients_goods_catalog WHERE salon_id=$1 AND NOT is_archived AND title IS NOT NULL AND trim(title)!='' AND ($2='' OR lower(title) LIKE '%' || lower($2) || '%') ORDER BY lower(trim(title)) LIMIT 1000`. Per-row JS `if (isBlacklisted(r.cat)) continue;` skips blacklisted categories before grouping. `Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b,'ru')).map(([cat,items]) => ({cat,items}))` preserves the existing response contract. Tree-cache contract preserved (read+write under empty `search`, bypass otherwise). Empty catalog → `[]` cached, no blocking sync (D-19).
- **Net change:** 35 insertions, 18 deletions across `/products` and `/product-tree`. `/services`, `/service-tree`, `/sync-goods-categories`, prescriptions CRUD, template-settings, adherence-history all untouched.

### `backend/yclients-goods-catalog.test.js` (new, 275 lines)

- 4 `describe` blocks, 3 `jest.mock` calls (`./db`, `./services/yclients`, `./logger`), 1 `test.each` (16 parametrized blacklist cases).
- `HOME_CARE_CATEGORY_BLACKLIST` (3 tests): Set instance, size===6, all-lower-cased, contains the canonical 6 categories from D-03.
- `isBlacklisted` (16 cases via `test.each`): exact lower, mixed/UPPER case, leading+trailing whitespace, all 6 blacklist entries, positive non-blacklist (Forlled, Уходы для дома, Без категории), null/undefined/empty/numeric edge cases.
- `extractCategoryTitle` (5 tests): object shape (returns `g.category.title`), string shape, numeric `category_id` + catMap fallback, all-null fallback (4 sub-asserts), object without title falls through to null.
- `syncGoodsCatalog smoke` (5 tests):
  - Self-guard × 3 (empty `{}`, falsy creds, `null` salon) — verifies zero `ycGet`/`db.any`/`db.one`/`db.query` calls.
  - Happy path: bootstrap (`/good_categories/{cid}` returns 2 cats) → enumerate paginated `/goods/{cid}` (page 1 has rows, page 2 empty terminator) → 3 UPSERTs (`db.one` × 3) → archive (`db.query` × 1) → `clearTreeCache(1)` × 1. Verifies `inserted=3, updated=0, archived=0, goodsSeen=3, categoriesSeen=2, errors=0, durationMs:number, salonId:1`.
  - Partial failure: enumerate of catId=999 throws YClients 500; surviving cat 101 still upserts; verifies `errors=1, errorSamples[0]={step:'enumerate',catId:999}, inserted=1, clearTreeCache called once`.

## Verification Results

### 1. Syntax / require
- `NODE_PATH=…/backend/node_modules node -e "require('./backend/routes/home-care')"` → loads cleanly (only emits the unrelated JWT_SECRET startup warning).
- `NODE_PATH=…/backend/node_modules node -e "require('./backend/services/yclients-goods-catalog')"` → loads cleanly.

### 2. Structural grep checks (Tasks 1+2 acceptance criteria)
| Pattern | Required | Actual | Pass |
|---------|----------|--------|------|
| `FROM yclients_goods_catalog` (in routes) | === 2 | 2 (one /products, one /product-tree) | ✓ |
| `FROM goods_sale_items gsi JOIN goods_sales gs` (in routes) | === 0 | 0 | ✓ |
| `isBlacklisted` (in routes) | ≥ 3 | 3 (1 import + 2 uses) | ✓ |
| `salon_id = $1` (in routes) | ≥ 2 | 2 (both new handlers) | ✓ |
| `NOT is_archived` (in routes) | ≥ 2 | 2 | ✓ |
| `LIMIT 1000` (in /product-tree) | === 1 | 1 | ✓ |
| `localeCompare(b, 'ru')` (in /product-tree) | === 1 | 1 | ✓ |
| `yclients_category` (legacy column ref) | === 0 | 0 | ✓ |
| `require .* services/yclients-goods-catalog` (in routes) | === 1 | 1 | ✓ |
| Each route handler (`/products`, `/product-tree`, `/services`, `/service-tree`, `/sync-goods-categories`) | === 1 each | 1 each | ✓ |

### 3. Jest run
```
$ cd backend && jest yclients-goods-catalog --no-coverage
Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total
Snapshots:   0 total
Time:        ~0.4 s
```
All 29 tests green. No real network or DB calls — every dependency is mocked.

### 4. Test-file structural grep
| Pattern | Required | Actual | Pass |
|---------|----------|--------|------|
| `describe(` | ≥ 4 | 4 | ✓ |
| `jest.mock(` | === 3 | 3 (db, services/yclients, logger) | ✓ |
| `test.each` | ≥ 1 | 1 (16 cases) | ✓ |
| Tests in `isBlacklisted` describe | ≥ 6 | 16 | ✓ |
| Tests in `extractCategoryTitle` describe | ≥ 5 | 5 | ✓ |
| Tests in `HOME_CARE_CATEGORY_BLACKLIST` describe | ≥ 3 | 3 | ✓ |
| Tests in `syncGoodsCatalog smoke` describe | ≥ 4 | 5 | ✓ |

### 5. Multi-salon scoping (CLAUDE.md hard rule)
Every SQL touch of `yclients_goods_catalog` in `routes/home-care.js` carries `salon_id = $1` against `req.user.salonId`:
- /products (line 109): `WHERE salon_id = $1 AND NOT is_archived …`
- /product-tree (line 199): `WHERE salon_id = $1 AND NOT is_archived …`

### 6. Threat model compliance (Wave 3 scope)

| Threat ID | Mitigation in code | Status |
|-----------|--------------------|--------|
| T-03-W3-01 (SQL injection in `search`) | Both new handlers use `$2` parameter binds for the `search` term — `ILIKE '%' || $2 || '%'` (line 112) and `LIKE '%' || lower($2) || '%'` (line 202). User input is never concatenated into the SQL string. | Mitigated |
| T-03-W3-02 (cross-salon leak) | `salon_id = $1` with `req.user.salonId` in both new SELECTs (count=2). JWT-derived only — no client-controlled override. | Mitigated |
| T-03-W3-03 (oversized payload) | /product-tree `LIMIT 1000` (~80KB max payload); /products `LIMIT $3` is bounded by `cap = parseInt(limit) || 10` so worst-case 30 rows × small projection. | Mitigated |
| T-03-W3-04 (blacklist bypass via raw category_title) | Accepted — would require write access to the `yclients_goods_catalog` table, which is full DB compromise. Documented in plan threat register. | Accepted |
| T-03-W3-05 (repudiation) | Accepted — read-only endpoints; Express + nginx logs sufficient. | Accepted |
| T-03-W3-06 (privilege escalation) | Accepted — handlers behind existing `auth` middleware; specialist role explicitly granted access to `/api/home-care/*` per CLAUDE.md. No change to auth model. | Accepted |
| T-03-W3-07 (token leak in test fixtures) | Test uses literal `'fake-token'`; `grep -E "yclients_user_token.*['\"][a-zA-Z0-9]{20,}['\"]" backend/yclients-goods-catalog.test.js` → 0 matches. | Mitigated |

## Frontend Contract Preservation

Both endpoints retain the JSON shape that `frontend/js/pages/home-care.js` expects:
- `/products` → `[{title: string, id: number|string}]` (autocomplete)
- `/product-tree` → `[{cat: string, items: string[]}]` ordered by ru-locale `cat`

No frontend changes are required by Wave 3.

## Behaviour at runtime (current state — pre-Wave-4)

- The `yclients_goods_catalog` migration applies on next PM2 boot (Wave 1 deferred live application).
- The table is empty until `syncGoodsCatalog` runs.
- Until then, both new handlers return `[]` (D-19 — no blocking sync on request). This is the intentional bridge state Wave 3 is designed to produce. Wave 4 wires `syncGoodsCatalog` into the `0 */3 * * *` cron and runs the manual cutover on PERI CLINIC (salon_id=1) — at that point the dropdown begins to populate.

## Deviations from Plan

None — plan executed exactly as written. The Task 3 test file follows the `<action>` pattern verbatim:
- 4 `describe` blocks, 3 `jest.mock` calls at test-file-relative paths, `test.each` for parametrized blacklist tests, `beforeEach(jest.clearAllMocks)` to isolate mock state across the 5 `syncGoodsCatalog smoke` cases.
- The optional "object without title falls through" extractCategoryTitle case is included (5 tests in that describe — meets the plan's ≥5 target).
- Self-guard tests cover three failure paths (`{}`, falsy fields, `null` salon) — exceeds the plan's ≥4 syncGoodsCatalog tests.
- Partial-failure test verifies `errorSamples[0].step==='enumerate'` and `errorSamples[0].catId===999` per plan.

## Outstanding for Wave 4 (Plan 04)

Wave 4 finishes the production cutover:
- Wire `syncGoodsCatalog` into the existing `0 */3 * * *` cron handler in `backend/server.js` (after `syncGoodsCategories`).
- Manual cutover smoke: `pm2 restart` triggers `runMigrations()` (Wave 1 DDL applies idempotently) → first cron tick populates `yclients_goods_catalog` → expected `inserted ≈ 427, categoriesSeen ≈ 26, errors === 0` on PERI CLINIC.
- Optional checkpoint: human-verify the dropdown shows `≈ 246` items after the first sync (vs. ~151 currently), with the 6 blacklisted categories absent.

## Self-Check: PASSED

Verified before writing this section:
- `backend/yclients-goods-catalog.test.js` — FOUND
- `backend/routes/home-care.js` modification — FOUND (lines 12, 100-123, 187-219)
- Commit `af6c81e` — FOUND in `git log`
- Commit `e63ab87` — FOUND in `git log`
- Commit `e4064af` — FOUND in `git log`
- Jest run on test file — 29 passed / 29 total / 0 failed / 0 skipped
- Both endpoints load via `node -e "require('./backend/routes/home-care')"`
- All structural grep checks above pass
- No real network or DB calls during test run (all dependencies mocked)
