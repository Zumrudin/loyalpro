---
phase: 03-fix-home-care-product-dropdown-missing-items
plan: 01
subsystem: backend/services/home-care
tags: [migration, scaffold, bug-fix, yclients-goods-catalog, wave-1]
requires:
  - salons table (existing)
  - backend/db.js, backend/services/yclients.js, backend/logger.js (existing)
provides:
  - DB schema yclients_goods_catalog (CREATE TABLE IF NOT EXISTS in migrations.js)
  - 2 indexes idx_ygc_salon_active_cat (partial), idx_ygc_salon_last_seen
  - backend/services/yclients-goods-catalog.js scaffold with 4 exports
  - HOME_CARE_CATEGORY_BLACKLIST (Set of 6 D-03 categories)
  - isBlacklisted(title), extractCategoryTitle(g, catMap), syncGoodsCatalog(salon) (placeholder)
  - Restored bulk-path performance in syncGoodsCategories (D-10 fix)
affects:
  - backend/migrations.js (additive, runs on next server boot)
  - backend/services/home-care.js (single bulk-loop fix, no API change)
tech-stack:
  added: []
  patterns:
    - safe migrations via IF NOT EXISTS + .catch(() => {})
    - per-service module scaffold with explicit exports
    - blacklist as Set<string> for O(1) lookup
key-files:
  created:
    - backend/services/yclients-goods-catalog.js
  modified:
    - backend/migrations.js
    - backend/services/home-care.js
decisions:
  - D-03: Use exact 6 blacklisted YClients category titles (расходники, канцелярия, препараты, аптека, сертификаты сеть peri clinic, абонементы сеть peri clinic)
  - D-04: Compare blacklist via lower(trim(title)) for case + whitespace normalization
  - D-10: Replace g.id with g.good_id in syncGoodsCategories bulk loop — YClients always returns null for g.id
  - D-13/D-14: Schema uses is_archived BOOLEAN + last_seen_at TIMESTAMPTZ — soft-delete only, never destructive
metrics:
  duration: "2m 37s"
  completed: 2026-05-10
  tasks: 3
  commits: 3
  files_created: 1
  files_modified: 2
requirements:
  - GOAL-04
  - GOAL-07
---

# Phase 03 Plan 01: Wave 1 Foundation (migration + scaffold + bulk-loop bug fix) Summary

Wave 1 lays the foundation for the home-care product dropdown fix by adding the `yclients_goods_catalog` table + 2 indexes (soft-delete schema), creating a service scaffold (`backend/services/yclients-goods-catalog.js`) with the 6-entry category blacklist and pure helpers (`isBlacklisted`, `extractCategoryTitle`), and fixing a one-character bug in `syncGoodsCategories` (`g.id` → `g.good_id`) that had been silently disabling the bulk lookup path.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migration yclients_goods_catalog + 2 indexes | `14b5ed5` | backend/migrations.js |
| 2 | Scaffold yclients-goods-catalog.js (blacklist + helpers + sync placeholder) | `07a46d2` | backend/services/yclients-goods-catalog.js |
| 3 | Bug fix g.id → g.good_id in bulk loop | `ff8f14f` | backend/services/home-care.js |

## Verification Results

- `grep "yclients_goods_catalog" backend/migrations.js` → 3 occurrences (CREATE TABLE + 2 index ON-clauses); UNIQUE clause references columns rather than the table name.
- `CREATE TABLE IF NOT EXISTS yclients_goods_catalog` present once at line 316.
- `idx_ygc_salon_active_cat` index includes `WHERE NOT is_archived` partial predicate.
- `idx_ygc_salon_last_seen` index present.
- FK `salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE` present in new block.
- `backend/services/yclients-goods-catalog.js` syntactically valid (`node -c`).
- With `NODE_PATH=…/backend/node_modules` (winston is not in this worktree's node_modules), `require('./backend/services/yclients-goods-catalog')` exposes exactly 4 exports: `syncGoodsCatalog, HOME_CARE_CATEGORY_BLACKLIST, isBlacklisted, extractCategoryTitle`.
- `HOME_CARE_CATEGORY_BLACKLIST.size === 6`.
- `isBlacklisted('Расходники') === true`, `isBlacklisted('РАСХОДНИКИ ') === true` (case + whitespace), `isBlacklisted('Forlled') === false`, `isBlacklisted(null) === false`, `isBlacklisted('') === false`.
- `extractCategoryTitle({category:{title:'A'}},{}) === 'A'`, `extractCategoryTitle({category:'B'},{}) === 'B'`, `extractCategoryTitle({category_id:5},{5:'C'}) === 'C'`, `extractCategoryTitle({},{}) === null`.
- `await syncGoodsCatalog({})` returns `{skipped:true, reason:'no-yclients'}` (self-guard fires on missing creds).
- `home-care.js` diff = exactly 8 lines (4 removed + 4 added); `g.good_id` count === 4; `g.id == null` count === 0; `goodCatMap[g.id]` count === 0; `goodCatMap[g.good_id]` count === 3.

## DB Migration Application Status

The migration was added to `backend/migrations.js` but **not applied to the live DB** by this agent — production DB writes are out of scope for parallel worktree executors and the project's migration model is "applied on next server boot via `runMigrations`". The MCP `mcp__postgres__query` tool was unavailable in this agent's tool set; live verification of `to_regclass('yclients_goods_catalog')` is deferred to either (a) the next PM2 restart, which will run `runMigrations()` automatically and trigger the IF-NOT-EXISTS DDL idempotently, or (b) a follow-up via MCP postgres in the orchestrator/verifier step.

The migration is purely additive (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, all wrapped in `.catch(() => {})`) so re-runs are safe.

## Deviations from Plan

None — plan executed exactly as written.

The verify command in Task 2 (`node -e "const m = require('./backend/services/yclients-goods-catalog'); …"`) initially failed with `Cannot find module 'winston'` because this parallel worktree's `backend/node_modules` does not include `winston`. The code is syntactically valid (`node -c` passes) and the require chain succeeds when `NODE_PATH` is pointed at the main repo's `backend/node_modules`. This is a worktree environment quirk, not a code problem — main-tree CI/runtime resolves it normally.

## Outstanding for Wave 2 (Plan 02)

Wave 1 is intentionally non-functional in production:
- `yclients_goods_catalog` table exists but is empty until `syncGoodsCatalog` is wired.
- `syncGoodsCatalog(salon)` body is a `not-implemented` placeholder.
- `home-care.js` continues to drive the dropdown from `goods_sale_items` history (now faster thanks to D-10 fix); it does NOT yet read from `yclients_goods_catalog`.

Wave 2 (Plan 02) implements the `syncGoodsCatalog` body: bootstrap → enumerate per category via YClients API → UPSERT rows → soft-delete tail (mark `is_archived=true` for goods not seen in this run) → `clearTreeCache(salon.id)`.

Wave 3 (Plan 03) rewrites `/api/home-care/products` and the product-tree dropdown endpoints to read from `yclients_goods_catalog` (filtered by `NOT is_archived` and `NOT isBlacklisted(category_title)`).

Wave 4 (Plan 04) registers `syncGoodsCatalog` in the cron job and adds an admin-trigger checkpoint for manual sync verification.

## Self-Check: PASSED

Verified before writing this section:
- `backend/services/yclients-goods-catalog.js` — FOUND
- `backend/migrations.js` modification — FOUND (lines 314–342 contain the new block)
- `backend/services/home-care.js` modification — FOUND (g.good_id used in bulk loop)
- Commit `14b5ed5` — FOUND in `git log`
- Commit `07a46d2` — FOUND in `git log`
- Commit `ff8f14f` — FOUND in `git log`
