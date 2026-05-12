---
phase: 03-fix-home-care-product-dropdown-missing-items
reviewed: 2026-05-12T09:36:16Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - backend/migrations.js
  - backend/routes/home-care.js
  - backend/server.js
  - backend/services/home-care.js
  - backend/services/yclients-goods-catalog.js
  - backend/yclients-goods-catalog.test.js
findings:
  critical: 0
  warning: 2
  info: 6
  total: 8
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-05-12T09:36:16Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Reviewed the Phase-03 home-care goods-catalog sync work: new `yclients_goods_catalog` table + indexes in `migrations.js`, the new `services/yclients-goods-catalog.js` (paged YClients enumeration, `ON CONFLICT … RETURNING (xmax = 0)` upsert, 24h soft-delete sweep, category blacklist), the `g.id`→`g.good_id` fix in `services/home-care.js`, the repointed `/products` and `/product-tree` handlers in `routes/home-care.js`, the cron wiring in `server.js`, and the Jest test file.

Overall the implementation is solid: queries are correctly scoped to `salon_id`, the upsert/soft-delete design is sound, partial-failure resilience is handled, no YClients tokens are logged, and the test coverage for the pure helpers and the sync smoke path is good. No critical issues. Findings below are about a behavior regression (no fallback when the mirror is empty), a redundant double-load against the YClients API, and minor robustness/consistency nits.

## Warnings

### WR-01: `/products` and `/product-tree` have no fallback when the catalog mirror is empty

**File:** `backend/routes/home-care.js:101-123`, `backend/routes/home-care.js:187-219`
**Issue:** Both handlers now read exclusively from `yclients_goods_catalog`. For a salon that has YClients connected but whose catalog has not yet been synced (e.g. the first up-to-3-hour window after this deploy, or any salon where every `syncGoodsCatalog` run so far hit `skipped: true` because no `category_id`s could be discovered), these endpoints return an empty list — the home-care product dropdown is empty. The previous implementation derived options from sales history, so there was always *something*. There is also no manual trigger for the new sync: `POST /api/home-care/sync-goods-categories` still calls the old `syncGoodsCategories` (which populates `goods_sale_items.yclients_category`, a different table), not `syncGoodsCatalog`. So an operator who notices an empty dropdown has no in-app way to force a refill.
**Fix:** Either (a) add a manual trigger endpoint (e.g. `POST /api/home-care/sync-catalog` → `syncGoodsCatalog(salon)`), or (b) keep a sales-history fallback in `/products` / `/product-tree` when `yclients_goods_catalog` returns zero rows for the salon, mirroring the `/service-tree` pattern that already falls back to `records.services`. Option (a) is the smaller change and gives operators a recovery path.

### WR-02: Cron now does a redundant full crawl of YClients `/goods` twice per salon

**File:** `backend/server.js:120-132`, `backend/services/home-care.js:18-66`, `backend/services/yclients-goods-catalog.js:152-201`
**Issue:** The `0 */3 * * *` cron fires `syncGoodsCatalog(salon)` and `syncGoodsCategories(salon)` back-to-back (plus `runSync`), all un-awaited, for every active salon at once. Both `syncGoodsCatalog` and `syncGoodsCategories` page through the YClients `/goods/{cid}` endpoint — `syncGoodsCategories` additionally hits `/goods/{cid}/{good_id}` once per distinct sold good when the bulk map misses. Running both on the same schedule roughly doubles the YClients API load for goods data and increases the chance of hitting rate limits, after which both jobs degrade. Firing all salons' jobs concurrently (no `await`, no concurrency cap) compounds it.
**Fix:** Now that `yclients_goods_catalog` holds `category_title` per good, consider deriving `goods_sale_items.yclients_category` from the mirror (a single `UPDATE … FROM yclients_goods_catalog` join) instead of re-crawling YClients in `syncGoodsCategories`. At minimum, stagger the two jobs onto different cron minutes and/or run salons sequentially (`for … await`) so the API isn't hit by N salons × 2 crawls simultaneously.

## Info

### IN-01: Empty-title goods are counted in `goodsSeen` but are unreachable

**File:** `backend/services/yclients-goods-catalog.js:183`, `backend/routes/home-care.js:111`, `backend/routes/home-care.js:201`
**Issue:** `String(g.title || '').slice(0, 500)` stores `''` for goods whose YClients title is null/empty. Both read endpoints filter `title IS NOT NULL AND trim(title) != ''`, so those rows are written, counted in `goodsSeen`/`inserted`, kept un-archived — but never shown. Slightly misleading metrics; harmless.
**Fix:** Either skip goods with a blank title in the enumeration loop (`if (!String(g.title||'').trim()) continue;`), or accept it and add a comment.

### IN-02: `clearTreeCache(salonId)` drops the service-tree cache too

**File:** `backend/services/yclients-goods-catalog.js:214`, `backend/services/yclients.js:22`
**Issue:** `clearTreeCache` does `delete _treeCache[salonId]`, wiping both the `products` and `services` sub-entries. Each `syncGoodsCatalog` run therefore also invalidates the unrelated `/service-tree` cache, forcing a YClients re-fetch on the next call. Minor; only a cache-warmth concern.
**Fix:** If desired, add a key-scoped clear (`delete _treeCache[salonId]?.products`) and use it here; otherwise leave a note that this is intentional.

### IN-03: `/products` `cap * 3` overfetch can still under-deliver

**File:** `backend/routes/home-care.js:104-120`
**Issue:** The handler pulls `cap * 3` rows then drops blacklisted-category rows client-side. If a salon has more than `2 * cap` blacklisted-category goods sorting alphabetically before the wanted ones, the response can come back short of `cap` even though more matching non-blacklisted goods exist. The inline comment acknowledges the heuristic; flagging for awareness.
**Fix:** Push the blacklist into SQL — e.g. `AND lower(trim(coalesce(category_title,''))) <> ALL($blacklistArray)` — so `LIMIT` operates on already-filtered rows. The blacklist Set is already exported from the service module.

### IN-04: Index `idx_ygc_salon_active_cat` doesn't serve the read queries

**File:** `backend/migrations.js:332-336`
**Issue:** The partial index is on `(salon_id, category_title) WHERE NOT is_archived`, but `/products` and `/product-tree` filter on `salon_id` + `NOT is_archived` + a `title ILIKE/LIKE` predicate and order by `lower(trim(title))`. The leading `category_title` column isn't used by those queries, so they'll do a salon-scoped scan + sort regardless. Not a correctness issue and perf is out of scope for v1 — noting in case the index was intended to help the dropdown queries.
**Fix:** If the index is meant for the read path, key it on `(salon_id, lower(title))` (or add a separate expression index) — or drop it if nothing queries by `category_title`.

### IN-05: `errorSamples` carries raw `e.message` into cron logs / return value

**File:** `backend/services/yclients-goods-catalog.js:140`, `backend/services/yclients-goods-catalog.js:197`, `backend/services/yclients-goods-catalog.js:231`
**Issue:** `errors.push({ …, msg: e.message })` and the returned `errorSamples` propagate whatever the underlying HTTP client put in `e.message`. YClients auth uses a Bearer header (not a query param), so a token leak is unlikely, but if `ycGet`/axios ever surfaces the request URL or headers in the error message, those samples end up in `cron.log`. Low risk; defense-in-depth.
**Fix:** Either confirm `ycGet` never includes credentials in thrown error messages, or sanitize (`String(e.message).replace(/Bearer\s+\S+/gi,'Bearer ***')`) before pushing.

### IN-06: `db.one` on the upsert relies on `RETURNING` always yielding a row

**File:** `backend/services/yclients-goods-catalog.js:165-186`
**Issue:** `db.one` throws if zero rows come back. `INSERT … ON CONFLICT (…) DO UPDATE … RETURNING …` always returns exactly one row, so this is correct today — but it's worth a one-line comment, because if the `ON CONFLICT` clause were ever changed to `DO NOTHING` the statement would return zero rows on conflict and `db.one` would throw, aborting the whole category. (Behavior is fine as written; this is a maintainability note.)
**Fix:** Add a comment noting "`DO UPDATE` guarantees a returned row — keep `db.one`, do not switch to `DO NOTHING`."

---

_Reviewed: 2026-05-12T09:36:16Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
