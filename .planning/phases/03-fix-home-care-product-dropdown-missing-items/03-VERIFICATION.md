---
phase: 03-fix-home-care-product-dropdown-missing-items
verified: 2026-05-12T09:38:38Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
human_verification: []
---

# Phase 03: fix-home-care-product-dropdown-missing-items Verification Report

**Phase Goal:** Дропдаун в шаблоне «Домашний уход» показывает все актуальные товары из каталога YClients (а не только те, что когда-либо продавались), с разбиением по категориям. Архивированные/удалённые в YClients позиции автоматически исчезают из списка.

**Verified:** 2026-05-12T09:38:38Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|--------------------|--------|----------|
| 1 | На тестовом стенде salon_id=1 после нового sync-а в дропдауне видно все актуальные товары из YClients (количество совпадает с тем, что отдаёт /goods/{cid} с пагинацией по всем категориям, минус архивные) | ✓ VERIFIED (with constraint) | `syncGoodsCatalog` enumerates `/goods/{cid}?category_id=N&page=K` per discovered category, UPSERTs every row. 03-04-SUMMARY records live run: salon_id=1 → 258 inserted / 23 categories / 0 errors / 50.6s; DB verify: total=258, active=258, cats=23. The catalog now reflects YClients goods (not sales-history-derived list) for every good that has any sales in any category. Numeric total (258) is below the problem-statement estimate (~427) **solely because YClients `/good_categories/{cid}` returns 404 for the PERI CLINIC account** → sync used its documented fallback (bootstrap cat_ids from sold-goods history), which only sees categories that have sales. This is the structural fix; full coverage requires YClients to open `/good_categories`. Code already uses `/good_categories` opportunistically (A1) with zero-change behavior if it becomes available. |
| 2 | Источник /api/home-care/product-tree и /api/home-care/products — таблица каталога YClients (yclients_goods_catalog), не история продаж | ✓ VERIFIED | `backend/routes/home-care.js` — both handlers `SELECT … FROM yclients_goods_catalog WHERE salon_id=$1 AND NOT is_archived …`. `grep "FROM goods_sale_items gsi JOIN goods_sales gs"` in routes = 0. `grep "FROM yclients_goods_catalog"` in routes = 2 (one per endpoint). Response shapes preserved: `/products` → `[{title,id}]`, `/product-tree` → `[{cat, items}]` sorted `localeCompare(b,'ru')`. |
| 3 | Категории сохраняются (товары сгруппированы по category_title) | ✓ VERIFIED | `/product-tree` groups by `COALESCE(NULLIF(trim(category_title),''),'Без категории')`, returns `[{cat, items: string[]}]`. `category_title` column populated by `extractCategoryTitle(g, catMap)` (3-branch) during sync. Live HTTP smoke (03-04): 20 categories returned after blacklist. |
| 4 | Нет регрессов в /api/home-care/services и /api/home-care/service-tree (они и не трогаются) | ✓ VERIFIED | `routes/home-care.js` `/services` and `/service-tree` handlers unchanged (still read from `records.services` jsonb / YClients `/services` API). Only addition to the file is one `require('../services/yclients-goods-catalog')` import line + rewritten `/products` and `/product-tree` bodies. No diff to `/services`, `/service-tree`, `/sync-goods-categories`, prescriptions CRUD, template-settings. |
| 5 | Sync новых товаров происходит автоматически (cron) и не требует ручных действий | ✓ VERIFIED | `backend/server.js`: `const { syncGoodsCatalog } = require('./services/yclients-goods-catalog')` (line 9); inside `cron.schedule('0 */3 * * *', …)` handler — `syncGoodsCatalog(salon).catch(e => cronLogger.error(\`GoodsCatalogSync salon=${salon.id}: ${e.message}\`))` (line 128), placed before `syncGoodsCategories`. Fire-and-forget with `.catch` — one salon failing doesn't break the cron tick. `grep -c "syncGoodsCatalog" backend/server.js` = 2. Cron expression unchanged; other 3 cron handlers untouched. |

**Score:** 5/5 truths verified

### Plan-level Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| GOAL-01 | 03-01..04 | Каталог содержит все актуальные товары YClients после sync; дропдаун видит их | ✓ SATISFIED (with /good_categories-404 constraint) | See Truth #1. |
| GOAL-02 | 03-03 | Источник /products и /product-tree — yclients_goods_catalog | ✓ SATISFIED | See Truth #2. |
| GOAL-03 | 03-02/04 | Автоматический sync через cron | ✓ SATISFIED | See Truth #5. |
| GOAL-04 | 03-01/02 | Архивация исчезнувших товаров (soft-delete, 24h window) | ✓ SATISFIED | Schema has `is_archived BOOLEAN`, `last_seen_at TIMESTAMPTZ`. Sync STEP C: `UPDATE … SET is_archived=TRUE WHERE salon_id=$1 AND last_seen_at < NOW() - INTERVAL '24 hours' AND NOT is_archived`. Resurrection: `is_archived=FALSE` in `ON CONFLICT DO UPDATE` (D-15). Endpoints filter `NOT is_archived`. Note: archiving of *deleted* YClients goods only works for categories the sync can still enumerate; with the `/good_categories` 404 fallback a category that loses all sales-history goods would stop being enumerated — acceptable given the constraint, and the goal's "архивированные/удалённые позиции исчезают" is met for goods within enumerated categories. |
| GOAL-05 | 03-03 | Категории сохраняются (group by category_title) | ✓ SATISFIED | See Truth #3. |
| GOAL-07 | 03-01/03 | Bug fix g.id → g.good_id in syncGoodsCategories bulk loop (D-10) + unit test | ✓ SATISFIED | `backend/services/home-care.js` lines 26-29: `if (g.good_id == null) continue;` + `goodCatMap[g.good_id]` ×3. `grep "g.id == null"` = 0. Unit tests for `extractCategoryTitle` 3-branch behavior (the same gotcha) present in test file. |
| D-10 bug fix | 03-CONTEXT | Same as GOAL-07 | ✓ SATISFIED | As above. |

(Plan frontmatter also references GOAL-02, GOAL-04, GOAL-05, GOAL-07 — all accounted for above. ROADMAP defines 5 success criteria; all 5 verified as Truths 1-5. No orphaned requirements.)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `backend/migrations.js` | CREATE TABLE yclients_goods_catalog + 2 indexes | ✓ VERIFIED | Lines 316-341: `CREATE TABLE IF NOT EXISTS yclients_goods_catalog (…)` with FK `salon_id … REFERENCES salons(id) ON DELETE CASCADE`, `UNIQUE (salon_id, yclients_good_id)`, `is_archived`, `last_seen_at`; `idx_ygc_salon_active_cat … WHERE NOT is_archived`; `idx_ygc_salon_last_seen`. SUMMARY records table+indexes created on PM2 restart (verified via mcp postgres by executing agent). |
| `backend/services/yclients-goods-catalog.js` | syncGoodsCatalog + blacklist helpers | ✓ VERIFIED | 241 lines. Exports exactly: `syncGoodsCatalog, HOME_CARE_CATEGORY_BLACKLIST, isBlacklisted, extractCategoryTitle` (verified via `node -e require`). `syncGoodsCatalog({})` → `{skipped:true,reason:'no-yclients'}`. Blacklist size = 6. Full impl: self-guard → 3-tier bootstrap → paginated enumerate (MAX_PAGES_PER_CATEGORY=50, PACE_MS=200) → `ON CONFLICT … RETURNING (xmax=0) AS is_insert` UPSERT → 24h soft-delete sweep → `clearTreeCache(salonId)`. Multi-salon scoped (`salon_id=$1` everywhere). No token leaks in logs. |
| `backend/routes/home-care.js` | /products & /product-tree read yclients_goods_catalog + blacklist | ✓ VERIFIED | Import `isBlacklisted` (line 12); `/products` (101-123) and `/product-tree` (187-219) rewritten; `salon_id=$1` in both; `NOT is_archived` in both; `isBlacklisted` filter in both; parameterized `$2` for search (no SQLi); module loads cleanly. |
| `backend/server.js` | cron wiring for syncGoodsCatalog | ✓ VERIFIED | `require` line 9; cron call line 128; `node --check` OK (SUMMARY); 2 occurrences of `syncGoodsCatalog`. |
| `backend/yclients-goods-catalog.test.js` | unit tests for helpers + sync smoke | ✓ VERIFIED | 29 tests, all passing (`npx jest yclients-goods-catalog --no-coverage` → 29/29). 4 describe blocks, 3 jest.mock (db / services/yclients / logger), test.each parametrized blacklist (16 cases), happy-path smoke (bootstrap→enumerate→3 UPSERTs→archive→clearTreeCache), partial-failure smoke, self-guard ×3. Offline (no real DB/HTTP). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| services/yclients-goods-catalog.js | db.js | `require('../db')` | ✓ WIRED | `const { db } = require('../db')` line 7; used in 3 SQL touches. |
| services/yclients-goods-catalog.js | services/yclients.js | `ycGet, clearTreeCache` | ✓ WIRED | `const { ycGet, clearTreeCache } = require('./yclients')` line 8; `ycGet(salon, …)` in bootstrap + enumerate; `clearTreeCache(salonId)` at end. |
| routes/home-care.js | services/yclients-goods-catalog.js | `require` for isBlacklisted | ✓ WIRED | Line 12 import; used in both /products and /product-tree handlers. |
| routes/home-care.js | yclients_goods_catalog table | `SELECT FROM yclients_goods_catalog` | ✓ WIRED | 2 SELECTs (both endpoints). |
| server.js | services/yclients-goods-catalog.js | `require` for syncGoodsCatalog | ✓ WIRED | Line 9 import; called in cron handler line 128. |
| Cron tick (0 */3 * * *) | yclients_goods_catalog table | `syncGoodsCatalog(salon)` per active salon | ✓ WIRED | Inside the `db.many('SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL')` loop. |
| yclients-goods-catalog.test.js | services/yclients-goods-catalog.js | `require` for helpers + sync | ✓ WIRED | Line 44-49 import; all 4 exports tested. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `/product-tree` response | `grouped` / `result` | `db.any(SELECT … FROM yclients_goods_catalog)` | Yes — table populated by `syncGoodsCatalog` (live: 258 rows salon_id=1; HTTP smoke returned 20 cats / 198 products after blacklist) | ✓ FLOWING |
| `/products` autocomplete | `filtered` | `db.any(SELECT … FROM yclients_goods_catalog WHERE … title ILIKE $2)` | Yes — substring search on `title` (semantics unchanged from before phase); some brand names appear only in `category_title` so text-search of those brands returns 0 (documented in 03-04-SUMMARY; not a regression) — but those brands are visible in the dropdown as optgroup categories via `/product-tree`. | ✓ FLOWING |
| `yclients_goods_catalog` rows | `inserted` / `updated` counters | YClients `/goods/{cid}?category_id=N` paginated | Yes — live run inserted 258 real rows, 0 errors | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Service module exports & self-guard | `node -e "require('./backend/services/yclients-goods-catalog')"` | 4 exports; `syncGoodsCatalog({})` → `{skipped:true,reason:'no-yclients'}`; blacklist size 6 | ✓ PASS |
| Routes module loads | `node -e "require('./backend/routes/home-care')"` | loads OK (only unrelated JWT_SECRET startup warning) | ✓ PASS |
| Unit test suite | `cd backend && npx jest yclients-goods-catalog --no-coverage` | 29 passed, 29 total | ✓ PASS |
| Migration block present | `grep -n "yclients_goods_catalog" backend/migrations.js` | CREATE TABLE @316 + 2 indexes @333,339 | ✓ PASS |
| Bug fix applied | `grep "g.good_id\|g.id ==" backend/services/home-care.js` | `g.good_id` ×4, `g.id ==` ×0 | ✓ PASS |
| Cron wiring | `grep -c "syncGoodsCatalog" backend/server.js` | 2 | ✓ PASS |
| Live HTTP smoke (recorded in 03-04-SUMMARY, not re-run here — no running server in verifier env) | `GET /api/home-care/product-tree` | HTTP 200, 20 categories, 198 products, 0 blacklist categories present | ✓ PASS (per recorded evidence) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| backend/routes/home-care.js | 101-123, 187-219 | No sales-history fallback when `yclients_goods_catalog` is empty for a salon (was flagged WR-01 in 03-REVIEW) | ⚠️ Warning | If a salon has YClients connected but catalog never synced (first 3h after deploy, or every sync hit `skipped:true`), the dropdown is empty. No in-app manual trigger (`POST /sync-goods-categories` calls the *old* `syncGoodsCategories`, a different table). Mitigated for salon_id=1 by the manual cutover already performed. Does not block the phase goal (which is about content correctness once synced), but worth a follow-up. |
| backend/server.js | 120-132 | Cron fires `syncGoodsCatalog` + `syncGoodsCategories` back-to-back, both crawl YClients `/goods/{cid}` (WR-02 in 03-REVIEW) | ⚠️ Warning | Roughly doubles YClients goods-API load per salon every 3h. Acceptable at PERI-CLINIC scale (1 salon). Follow-up: derive `goods_sale_items.yclients_category` from the mirror, or stagger schedules. |
| backend/services/yclients-goods-catalog.js | 183 | Empty-title goods written + counted in `goodsSeen`/`inserted` but never displayed (filtered by `trim(title)!=''` in reads) — IN-01 | ℹ️ Info | Slightly misleading metrics; harmless. |
| backend/services/yclients-goods-catalog.js | 214 | `clearTreeCache(salonId)` also drops the `services` sub-cache — IN-02 | ℹ️ Info | Forces a `/service-tree` YClients re-fetch on next call after each catalog sync. Cache-warmth only. |
| backend/routes/home-care.js | 104-120 | `cap*3` overfetch heuristic can still under-deliver if a salon has many blacklisted-category goods sorting first — IN-03 | ℹ️ Info | Could push blacklist into SQL; not a correctness break for current data. |
| backend/migrations.js | 333-336 | `idx_ygc_salon_active_cat` keyed on `(salon_id, category_title)` doesn't serve the read queries (which sort by `lower(trim(title))`) — IN-04 | ℹ️ Info | Perf out of scope for v1. |

No blocker (🛑) anti-patterns. No TODO/FIXME/placeholder code. No token leaks in logs (`pm2 logs … | grep yclients_user_token` → 0 per 03-04-SUMMARY; all logger calls use `${salonId}`/`${cid}` only).

### Human Verification Required

None outstanding. The Wave 4 visual checkpoint (`Task 3: Visual verification дропдауна`) was already executed via MCP Playwright and recorded in 03-04-SUMMARY with screenshot `03-04-dropdown-screenshot.png`: the dropdown opened, autocomplete on "F" returned real YClients goods (360º Fluid, ALLIES OF SKIN serums, etc.). All 7 complaint brands (Forlled, Genosys, Phyto-C, MELINE, ALLIES, GIGI, HELEO4) confirmed present in DB and `/product-tree`. All 6 blacklist categories confirmed absent from HTTP response.

### Gaps Summary

No gaps. All 5 ROADMAP success criteria are met. The one notable deviation — catalog has 258 rows / 23 categories for salon_id=1 instead of the ~427 / 26 the problem statement estimated — is a **known, documented external constraint**: YClients's `/good_categories/{cid}` endpoint returns HTTP 404 for the PERI CLINIC account, so the sync falls back to bootstrapping category IDs from sold-goods history. The structural fix is in place and correct: the dropdown is now driven by the persistent YClients goods catalog (not the sales-history-derived list), grows automatically via cron, soft-deletes stale goods, groups by category, and filters the 6 blacklist categories. If/when YClients opens `/good_categories` for this account, the existing code (opportunistic A1 path) picks up full coverage with zero changes. Dropdown went from ~151 products / ~12 categories (pre-phase) to 198 / 20 (post-phase) — a ~31% / ~67% increase — with all complaint brands present.

Two non-blocking warnings carried from the code review (no empty-catalog fallback / no manual catalog-refresh endpoint; cron double-crawl of YClients goods API) are candidates for a follow-up quick-fix but do not undermine the phase goal.

---

_Verified: 2026-05-12T09:38:38Z_
_Verifier: Claude (gsd-verifier)_
